import fs from 'node:fs';
import path from 'node:path';
import { createTracker } from './adapters/trackers/index.mjs';
import { createVcs } from './adapters/vcs/index.mjs';
import { providerName, runAgent } from './adapters/agents/index.mjs';
import { validateArtifacts } from './artifacts.mjs';
import { appendChangelog, fileHash, findContext, rebuildFeatureIndex, seedReadme, writeLesson, writePlanDoc, readmeRel } from './docs.mjs';
import { runShell } from './exec.mjs';
import { acquireLock } from './lock.mjs';
import { diffSnapshots, snapshot, validatePlan } from './plan.mjs';
import { preflightTicket } from './preflight.mjs';
import { buildProjectIndex, findIndexContext, writeProjectIndex } from './indexer.mjs';
import { buildPlanPrompt, buildPrompt } from './prompt.mjs';
import { State } from './state.mjs';
import { ensureDir, isSafeId, readJson, redact, render, sanitizeText, tail } from './util.mjs';

const MIN = 60000;
export const PREFIX = '[agent-pipeline] ';

/**
 * One scheduler tick. job = "code" | "plan" | "all" (default).
 * The two jobs have separate locks, so they can be scheduled independently or run at the same time.
 * Result of "all" is the code result with the plan result attached as `plan`.
 */
export async function runOnce(cfg, deps = {}, opts = {}) {
  const job = opts.job ?? 'all';
  const state = new State(cfg.stateDir);
  if (state.isPaused()) return { status: 'paused' };
  const ctx = {
    cfg,
    state,
    tracker: deps.tracker ?? createTracker(cfg),
    vcs: deps.vcs ?? createVcs(cfg),
    secrets: [process.env[cfg.tracker.tokenEnv]].filter(Boolean),
  };
  const guarded = async (name, fn) => {
    const lock = acquireLock(path.join(cfg.stateDir, `${name}.lock`), { name, staleMs: cfg.limits.lockStaleMinutes * MIN });
    if (!lock) return { status: 'locked' };
    try { return await fn({ ...ctx, lock }); } finally { lock.release(); }
  };
  if (job === 'code') return guarded('code', (c) => codeTick(c, opts));
  if (job === 'plan') return guarded('plan', (c) => planTick(c, opts));
  const code = await guarded('code', (c) => codeTick(c, opts));
  const plan = await guarded('plan', (c) => planTick(c, opts));
  return { ...code, plan };
}

// ---------------------------------------------------------------- code job

async function codeTick(ctx, opts) {
  const { state, tracker } = ctx;
  const inflight = state.get('inflight');

  // Parked work needs no AI, so it is always finished first (one ticket at a time).
  if (inflight?.stage === 'parked' && !opts.dryRun) {
    const r = await qaAndCheckIn(ctx, inflight);
    await maybeDeploy(ctx);
    return r;
  }

  const provider = chooseProvider(ctx, 'code');
  if (!provider) {
    await maybeDeploy(ctx);
    return { status: 'provider-hold' };
  }

  let ticket;
  if (inflight?.stage === 'coding') ticket = await tracker.get(inflight.ticketId);
  else {
    ticket = await pickTicket(ctx);
    if (!ticket) {
      await maybeDeploy(ctx);
      return { status: 'idle' };
    }
  }
  if (!isSafeId(ticket.id)) return { status: 'error', reason: `Unsafe ticket id: ${ticket.id}` };
  if (opts.dryRun) return { status: 'dry-run', ticket: ticket.id, title: ticket.title, provider, hasPlan: !!state.get(`plan-${ticket.id}`) };

  const r = await codingStage(ctx, ticket, provider);
  if (r.status !== 'parked') return r;
  const q = await qaAndCheckIn(ctx, state.get('inflight'));
  await maybeDeploy(ctx);
  return q;
}

function chooseProvider(ctx, job) {
  const { cfg, state } = ctx;
  const names = [providerName(cfg, job), ...cfg.agent.fallback];
  for (const name of names) {
    const hold = state.get(`hold-${name}`);
    if (!hold || hold.until < Date.now()) return name;
  }
  return null;
}

function holdProvider(ctx, name, minutes, reason) {
  ctx.state.set(`hold-${name}`, { until: Date.now() + minutes * MIN, reason });
  ctx.state.event('provider-hold', { provider: name, reason, minutes });
}

async function pickTicket(ctx) {
  const { cfg, state, tracker } = ctx;
  const hold = new Set(state.get('hold', []));
  const redoAll = await tracker.list(['redo']);
  const redo = redoAll.filter((t) => !hold.has(t.id));
  if (redo.length) return redo[0];
  if (redoAll.length >= cfg.limits.pauseReadyWhenRedoAtLeast) return null; // clear the redo backlog before new work
  return (await tracker.list(['ready'])).find((t) => !hold.has(t.id)) ?? null;
}

async function humanComments(ctx, id) {
  try {
    const all = await ctx.tracker.getComments(id);
    return all.filter((c) => !c.startsWith(PREFIX)).slice(-10).map((c) => c.slice(0, 1500));
  } catch { return []; }
}

async function preflight(ctx, ticket, comments, context) {
  if (!ctx.cfg.preflight.enabled) return null;
  const result = preflightTicket(ctx.cfg, ticket, context);
  ctx.state.set(`preflight-${ticket.id}`, result);
  ctx.state.event('preflight', { ticket: ticket.id, ok: result.ok, risks: result.risks, blockers: result.blockers });
  return result;
}

async function stopForPreflight(ctx, ticket, restoreKey, result) {
  if (!result || result.ok) return false;
  const missing = result.blockers.join('; ');
  await note(ctx, ticket.id, `Before an AI agent is started, please add ${missing}. Then set the ticket to "resume".` , { plan: true });
  await ctx.tracker.setStatus(ticket.id, 'needInfo');
  ctx.state.set('inflight', null);
  return true;
}

async function codingStage(ctx, ticket, provider) {
  const { cfg, state, tracker, vcs, lock } = ctx;
  const id = ticket.id;
  const isRedo = ticket.statusKey === 'redo';
  const restoreKey = isRedo ? 'redo' : 'ready';
  state.set('inflight', { ticketId: id, title: ticket.title, stage: 'coding', startedAt: new Date().toISOString() });

  // A ticket nobody has planned yet (for example put straight into "ready") is planned first.
  let plan = state.get(`plan-${id}`);
  if (cfg.plan.enabled && !plan) {
    const pp = chooseProvider(ctx, 'plan');
    if (!pp) { state.set('inflight', null); return { status: 'provider-hold' }; }
    const r = await planStage(ctx, ticket, pp, { inline: true });
    state.set('inflight', null);
    if (r.status !== 'planned') return r;
    plan = state.get(`plan-${id}`);
    state.set('inflight', { ticketId: id, title: ticket.title, stage: 'coding', startedAt: new Date().toISOString() });
  }
  if (!cfg.plan.enabled) plan = null;

  const preflightComments = await humanComments(ctx, id);
  const preflightContext = findContext(cfg.workspace, cfg, { id, title: ticket.title, description: ticket.description, comments: preflightComments, hintFeature: plan?.feature });
  const preflightResult = await preflight(ctx, ticket, preflightComments, preflightContext);
  if (await stopForPreflight(ctx, ticket, restoreKey, preflightResult)) return { status: 'need-info', reason: 'preflight' };

  await tracker.setStatus(id, 'inDevelopment');
  let prep;
  try {
    prep = await vcs.prepare({ ticket });
  } catch (e) {
    return failTicket(ctx, ticket, `Could not prepare the workspace: ${e.message}`);
  }
  const workDir = prep.workDir;
  const artifactsDir = path.join(workDir, render(cfg.artifacts.dir, { ticket: id }));
  ensureDir(artifactsDir);
  for (const stale of ['needinfo.json', 'lesson.json']) fs.rmSync(path.join(artifactsDir, stale), { force: true });

  // Documentation the agent starts from: the feature README (seeded from the plan if it does not exist yet).
  let readmePath = null;
  let docsBefore = null;
  if (plan) {
    readmePath = seedReadme(workDir, cfg, plan).rel;
    docsBefore = { hash: fileHash(path.join(workDir, readmePath)) };
    fs.writeFileSync(path.join(artifactsDir, 'plan.json'), JSON.stringify(plan, null, 2));
  }
  const comments = preflightComments;
  const context = findContext(workDir, cfg, { id, title: ticket.title, description: ticket.description, comments, hintFeature: plan?.feature });
  const indexContext = findIndexContext(buildProjectIndex(workDir, cfg), cfg, { title: ticket.title, description: ticket.description, comments, featureContext: context });

  const failure = state.get('failures', {})[id];
  const promptFile = path.join(cfg.stateDir, 'prompts', `${id}-code.md`);
  ensureDir(path.dirname(promptFile));
  fs.writeFileSync(promptFile, buildPrompt({ cfg, ticket, workDir, artifactsDir, failure, plan, context, comments, readmePath, isRedo, preflight: preflightResult, indexContext }));

  state.event('agent-start', { ticket: id, provider, job: 'code' });
  const res = await runAgent(provider, cfg, {
    promptFile, cwd: workDir, ticket: id, job: 'code',
    logFile: path.join(cfg.stateDir, 'logs', `${id}-code-${Date.now()}.log`),
    onTick: () => lock.beat(),
  });
  state.event('agent-finish', { ticket: id, provider, job: 'code', code: res.code, timedOut: res.timedOut, quotaHit: res.quotaHit, unavailable: !!res.unavailable });

  if (res.unavailable) {
    holdProvider(ctx, provider, cfg.limits.unavailableHoldMinutes, 'unavailable');
    state.set('inflight', null);
    await tracker.setStatus(id, restoreKey);
    return { status: 'agent-unavailable', provider, reason: res.unavailable };
  }
  if (res.quotaHit) {
    holdProvider(ctx, provider, cfg.limits.quotaHoldMinutes, 'quota');
    state.set('inflight', null);
    await tracker.setStatus(id, restoreKey);
    return { status: 'quota-hold', provider };
  }

  let needInfo = null;
  try { needInfo = readJson(path.join(artifactsDir, 'needinfo.json'), null); } catch { /* treated as missing */ }
  if (needInfo?.question) {
    await tracker.comment(id, PREFIX + redact(`Question before this can be built: ${needInfo.question}`, ctx.secrets).slice(0, 1500));
    await tracker.setStatus(id, 'needInfo');
    state.set('inflight', null);
    return { status: 'need-info' };
  }
  if (res.timedOut) return failTicket(ctx, ticket, `The coding agent ran out of time (${cfg.agent.maxMinutes} minutes).`);

  const v = validateArtifacts({ cfg, ticketId: id, workDir, artifactsDir, plan, docsBefore, isRedo });
  if (!v.ok) {
    const extra = res.code !== 0 ? ` Agent exit code ${res.code}: ${tail(res.tail, 300)}` : '';
    return failTicket(ctx, ticket, `Handoff files are not valid: ${v.errors.join('; ')}.${extra}`);
  }

  for (const [name, cmd] of [['build', cfg.gates.build], ['unit tests', cfg.gates.unitTests]]) {
    if (!cmd) continue;
    const g = await runShell(cmd, { cwd: workDir, timeoutMs: cfg.gates.timeoutMinutes * MIN });
    if (g.code !== 0) return failTicket(ctx, ticket, `The ${name} step failed: ${tail(g.tail, 800)}`);
  }

  await tracker.setStatus(id, 'parked');
  state.set('inflight', {
    ticketId: id, title: ticket.title, stage: 'parked', workDir, artifactsDir, files: v.files, deletedFiles: v.deletedFiles,
    branch: prep.branch ?? null, feature: plan?.feature ?? null, summary: v.summary, lesson: v.lesson, readmeChanged: v.readmeChanged,
  });
  state.event('parked', { ticket: id });
  return { status: 'parked' };
}

async function qaAndCheckIn(ctx, inf) {
  const { cfg, state, tracker, vcs } = ctx;
  const ticket = { id: inf.ticketId, title: inf.title };
  await tracker.setStatus(ticket.id, 'testing');
  const cmd = render(cfg.qa.command, { ticket: ticket.id, workDir: inf.workDir, artifactsDir: inf.artifactsDir });
  const qa = await runShell(cmd, { cwd: inf.workDir, timeoutMs: cfg.qa.timeoutMinutes * MIN, logFile: path.join(cfg.stateDir, 'logs', `${ticket.id}-qa.log`) });
  state.event('qa', { ticket: ticket.id, code: qa.code });
  const codes = cfg.qa.exitCodes;

  if (qa.code === codes.blocked) {
    await note(ctx, ticket.id, `QA could not run (environment, login or tooling problem), so nothing was checked in. ${tail(qa.tail, 500)}`);
    await tracker.setStatus(ticket.id, 'blocked');
    state.set('inflight', null);
    return { status: 'blocked', reason: 'qa-blocked' };
  }
  if (qa.code !== codes.pass) return failTicket(ctx, ticket, `QA failed (exit ${qa.code}): ${tail(qa.tail, 800)}`);

  // QA passed: the pipeline (not the agent) writes the documentation that must travel with the code.
  const files = [...inf.files];
  const deletedFiles = [...(inf.deletedFiles ?? [])];
  try {
    const plan = inf.feature ? state.get(`plan-${ticket.id}`) : null;
    if (plan) {
      files.push(writePlanDoc(inf.workDir, cfg, plan, ticket));
      if (inf.readmeChanged) files.push(readmeRel(cfg, plan.feature));
      if (cfg.docs.changelog) files.push(appendChangelog(inf.workDir, cfg, { feature: plan.feature, ticket, summary: inf.summary }));
      if (inf.lesson) files.push(...writeLesson(inf.workDir, cfg, { ticket, feature: plan.feature, lesson: inf.lesson }));
      files.push(rebuildFeatureIndex(inf.workDir, cfg));
    }
    files.push(...writeProjectIndex(inf.workDir, cfg));
  } catch (e) {
    return failTicket(ctx, ticket, `QA passed but writing the documentation failed: ${e.message}`);
  }

  let ci;
  try {
    ci = await vcs.checkIn({ ticket, workDir: inf.workDir, files: [...new Set(files)], deletedFiles: [...new Set(deletedFiles)], message: `${ticket.id}: ${sanitizeText(ticket.title)}`, branch: inf.branch });
  } catch (e) {
    return failTicket(ctx, ticket, `QA passed but check-in failed: ${e.message}`);
  }
  await tracker.setStatus(ticket.id, 'pass');
  const ready = state.get('deploy-ready', []);
  ready.push({ ticketId: ticket.id, ref: ci.ref, at: new Date().toISOString() });
  state.set('deploy-ready', ready);
  for (const key of ['failures', 'attempts']) {
    const m = state.get(key, {});
    delete m[ticket.id];
    state.set(key, m);
  }
  state.set('inflight', null);
  state.event('checked-in', { ticket: ticket.id, ref: ci.ref, files: [...new Set(files)].length, deletedFiles: deletedFiles.length });
  return { status: 'pass', ticket: ticket.id, ref: ci.ref };
}

async function maybeDeploy(ctx) {
  const { cfg, state, tracker } = ctx;
  if (!cfg.deploy.command) return null;
  const ready = state.get('deploy-ready', []);
  if (ready.length < cfg.deploy.batchMin) return null;
  const run = (cmd) => runShell(cmd, { cwd: cfg.workspace, timeoutMs: cfg.deploy.timeoutMinutes * MIN, logFile: path.join(cfg.stateDir, 'logs', 'deploy.log') });
  const d = await run(cfg.deploy.command);
  state.event('deploy', { code: d.code, tickets: ready.length });
  if (d.code !== 0) return { status: 'deploy-failed' };
  if (cfg.deploy.smokeCommand) {
    const s = await run(cfg.deploy.smokeCommand);
    state.event('smoke', { code: s.code });
    if (s.code !== 0) return { status: 'smoke-failed' };
  }
  for (const r of ready) {
    await tracker.setStatus(r.ticketId, 'signOff');
    await note(ctx, r.ticketId, `Deployed and smoke-checked (${r.ref}). Ready for tester sign-off.`);
  }
  state.set('deploy-ready', []);
  return { status: 'deployed', count: ready.length };
}

// First failures go to "redo" with evidence; after maxAttempts the ticket is blocked for a human.
async function failTicket(ctx, ticket, reason) {
  const { cfg, state, tracker } = ctx;
  const id = ticket.id;
  const attempts = state.get('attempts', {});
  const failures = state.get('failures', {});
  const n = (attempts[id] ?? 0) + 1;
  failures[id] = redact(reason, ctx.secrets).slice(-2000);
  state.set('failures', failures);
  state.set('inflight', null);
  if (n >= cfg.limits.maxAttempts) {
    attempts[id] = 0;
    state.set('attempts', attempts);
    await tracker.setStatus(id, 'blocked');
    await note(ctx, id, `Stopped after ${n} failed attempts. A developer needs to look at this, then set it back to ready. Latest problem: ${reason}`);
    state.event('blocked', { ticket: id, attempts: n });
    return { status: 'blocked', reason };
  }
  attempts[id] = n;
  state.set('attempts', attempts);
  await tracker.setStatus(id, 'redo');
  await note(ctx, id, `Attempt ${n} of ${cfg.limits.maxAttempts} failed, sent back for another pass. ${reason}`);
  state.event('redo', { ticket: id, attempts: n });
  return { status: 'redo', reason };
}

async function note(ctx, id, text, { plan = false } = {}) {
  const on = plan ? ctx.cfg.comments.onPlan : ctx.cfg.comments.onFailure;
  if (!on) return;
  try { await ctx.tracker.comment(id, PREFIX + redact(text, ctx.secrets).slice(0, 1500)); } catch { /* a comment failure must not stop the pipeline */ }
}

// ---------------------------------------------------------------- plan job

async function planTick(ctx, opts) {
  const { cfg, tracker, state } = ctx;
  if (!cfg.plan.enabled) return { status: 'disabled' };
  const hold = new Set(state.get('hold', []));
  const queue = [...(await tracker.list(['resume'])), ...(await tracker.list(['new']))].filter((t) => !hold.has(t.id) && isSafeId(t.id));
  if (opts.dryRun) return { status: 'dry-run', wouldPlan: queue.slice(0, cfg.plan.perTick).map((t) => t.id) };
  const done = [];
  for (const ticket of queue.slice(0, cfg.plan.perTick)) {
    const provider = chooseProvider(ctx, 'plan');
    if (!provider) { done.push({ status: 'provider-hold' }); break; }
    const r = await planStage(ctx, ticket, provider, {});
    done.push({ ticket: ticket.id, ...r });
    if (['quota-hold', 'agent-unavailable'].includes(r.status)) break;
  }
  return { status: done.length ? 'planned-batch' : 'idle', results: done };
}

async function planStage(ctx, ticket, provider, { inline = false } = {}) {
  const { cfg, state, tracker, lock } = ctx;
  const id = ticket.id;
  const restoreKey = ['new', 'resume', 'ready', 'redo'].includes(ticket.statusKey) ? ticket.statusKey : 'new';
  const root = cfg.workspace;
  const prevPlan = state.get(`plan-${id}`) ?? state.get(`plan-${id}-pending`);
  await tracker.setStatus(id, 'planning');

  const comments = await humanComments(ctx, id);
  const artifactsDir = path.join(root, render(cfg.artifacts.dir, { ticket: id }));
  ensureDir(artifactsDir);
  fs.rmSync(path.join(artifactsDir, 'plan.json'), { force: true });

  const context = findContext(root, cfg, { id, title: ticket.title, description: ticket.description, comments, hintFeature: prevPlan?.feature });
  const indexContext = findIndexContext(buildProjectIndex(root, cfg), cfg, { title: ticket.title, description: ticket.description, comments, featureContext: context });
  const preflightResult = await preflight(ctx, ticket, comments, context);
  if (await stopForPreflight(ctx, ticket, restoreKey, preflightResult)) return { status: 'need-info', reason: 'preflight' };
  const failure = state.get('plan-failures', {})[id];
  const promptFile = path.join(cfg.stateDir, 'prompts', `${id}-plan.md`);
  ensureDir(path.dirname(promptFile));
  fs.writeFileSync(promptFile, buildPlanPrompt({ cfg, ticket, comments, context, prevPlan, artifactsDir, failure, preflight: preflightResult, indexContext }));

  const ignoreRel = [path.relative(root, artifactsDir), path.relative(root, cfg.stateDir)].filter((p) => p && !p.startsWith('..'));
  const before = cfg.plan.snapshotGuard ? snapshot(root, cfg.plan.ignore, ignoreRel) : null;

  state.event('agent-start', { ticket: id, provider, job: 'plan', inline });
  const res = await runAgent(provider, cfg, {
    promptFile, cwd: root, ticket: id, job: 'plan',
    logFile: path.join(cfg.stateDir, 'logs', `${id}-plan-${Date.now()}.log`),
    onTick: () => lock.beat(),
  });
  state.event('agent-finish', { ticket: id, provider, job: 'plan', code: res.code, timedOut: res.timedOut });

  if (res.unavailable) {
    holdProvider(ctx, provider, cfg.limits.unavailableHoldMinutes, 'unavailable');
    await tracker.setStatus(id, restoreKey);
    return { status: 'agent-unavailable', provider, reason: res.unavailable };
  }
  if (res.quotaHit) {
    holdProvider(ctx, provider, cfg.limits.quotaHoldMinutes, 'quota');
    await tracker.setStatus(id, restoreKey);
    return { status: 'quota-hold', provider };
  }
  if (before) {
    const changed = diffSnapshots(before, snapshot(root, cfg.plan.ignore, ignoreRel));
    if (changed.length) return failPlan(ctx, ticket, restoreKey, `The planning agent changed project files, which it must never do: ${changed.slice(0, 8).join(', ')}. A developer must review and revert them.`, { hard: true });
  }
  if (res.timedOut) return failPlan(ctx, ticket, restoreKey, `The planning agent ran out of time (${cfg.agent.plan.maxMinutes} minutes).`);

  let plan;
  try { plan = readJson(path.join(artifactsDir, 'plan.json'), null); } catch (e) { return failPlan(ctx, ticket, restoreKey, e.message); }
  const v = validatePlan(plan, id);
  if (!v.ok) {
    const extra = res.code !== 0 ? ` Agent exit code ${res.code}: ${tail(res.tail, 300)}` : '';
    return failPlan(ctx, ticket, restoreKey, `plan.json is not valid: ${v.errors.join('; ')}.${extra}`);
  }

  if (prevPlan) state.set(`plan-${id}-v${prevPlan.version ?? 1}`, prevPlan);
  state.set(`plan-${id}-pending`, null);
  plan.version = (prevPlan?.version ?? 0) + 1;
  plan.plannedAt = new Date().toISOString();
  state.set(`plan-${id}`, plan);
  const pf = state.get('plan-failures', {});
  delete pf[id];
  state.set('plan-failures', pf);
  const pa = state.get('plan-attempts', {});
  delete pa[id];
  state.set('plan-attempts', pa);
  state.event('planned', { ticket: id, decision: plan.decision, feature: plan.feature ?? null, version: plan.version });

  if (plan.decision === 'need-info') {
    await note(ctx, id, `Question before this can be built: ${plan.question}`, { plan: true });
    await tracker.setStatus(id, 'needInfo');
    state.set(`plan-${id}`, null);
    state.set(`plan-${id}-pending`, plan);
    return { status: 'need-info', decision: plan.decision };
  }
  if (plan.decision === 'high-risk') {
    await note(ctx, id, `Plan is ready but needs a person to approve it first. Reason: ${plan.riskReason}. Set the ticket to "ready" to approve, or answer with changes and set it to "resume".`, { plan: true });
    await tracker.setStatus(id, 'approval');
    return { status: 'approval', decision: plan.decision };
  }
  await note(ctx, id, `Plan ready (${plan.type}, feature ${plan.feature}, ${plan.acceptance.length} acceptance checks): ${plan.summary}`, { plan: true });
  await tracker.setStatus(id, 'ready');
  return { status: 'planned', decision: plan.decision };
}

async function failPlan(ctx, ticket, restoreKey, reason, { hard = false } = {}) {
  const { cfg, state, tracker } = ctx;
  const id = ticket.id;
  const attempts = state.get('plan-attempts', {});
  const failures = state.get('plan-failures', {});
  const n = (attempts[id] ?? 0) + 1;
  failures[id] = redact(reason, ctx.secrets).slice(-2000);
  state.set('plan-failures', failures);
  if (hard || n >= cfg.limits.maxAttempts) {
    attempts[id] = 0;
    state.set('plan-attempts', attempts);
    await tracker.setStatus(id, 'blocked');
    await note(ctx, id, `Planning stopped${hard ? '' : ` after ${n} failed attempts`}. A developer needs to look at this, then set it back to resume. Problem: ${reason}`);
    state.event('plan-blocked', { ticket: id, attempts: n });
    return { status: 'blocked', reason };
  }
  attempts[id] = n;
  state.set('plan-attempts', attempts);
  await tracker.setStatus(id, restoreKey);
  await note(ctx, id, `Planning attempt ${n} of ${cfg.limits.maxAttempts} failed and will be retried. ${reason}`);
  state.event('plan-failed', { ticket: id, attempts: n });
  return { status: 'plan-failed', reason };
}
