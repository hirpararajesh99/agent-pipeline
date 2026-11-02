import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectRegistry } from './projects.mjs';
import { DEFAULTS, STATUS_KEYS, loadConfig } from './config.mjs';
import { initBrain, brainStatus, brainFreshness, analyzeBrain, runBrain } from './brain.mjs';
import { refreshBrain } from './brain-refresh.mjs';
import { brainReview, recordReview } from './brain-review.mjs';
import { lessonKnowledge, lessonDuplicates, recordLesson } from './brain-lessons.mjs';
import { redact, safeProjectPath, readJson, writeJson, isSafeId } from './util.mjs';
import { createTracker } from './adapters/trackers/index.mjs';
import { State } from './state.mjs';
import { runOnce } from './orchestrator.mjs';
import { setupWorkspaceProject, agentSettings, pipelineSettings } from './workspace-setup.mjs';
import { providerName, providerSpec } from './adapters/agents/index.mjs';
import { commandExists } from './exec.mjs';
import { ticketActions } from './ticket-actions.mjs';
import { findContext, fitContextBudget } from './docs.mjs';
import { buildProjectIndex, findIndexContext } from './indexer.mjs';

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** Local multi-project workspace. All routes are scoped through the registry. */
export function createWorkspaceServer({ port = 3000, registryFile } = {}) {
  const registry = projectRegistry(registryFile);
  const jobs = new Map();
  const pipelineJobs = new Map();
  const token = crypto.randomBytes(32).toString('hex');
  const html = fs.readFileSync(path.join(dirname, 'workspace.html'), 'utf8').replace('__WORKSPACE_TOKEN__', token);
  const server = http.createServer(async (req, res) => {
    let secrets = [];
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item, secrets) : item));
    };
    const host = req.headers.host;
    const expected = server.address()?.port;
    if (!host || ![`127.0.0.1:${expected}`, `localhost:${expected}`].includes(host)) return send(403, { error: 'Invalid host' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(403, { error: 'Invalid origin' });
    if (req.method !== 'GET' && (origin !== `http://${host}` || req.headers['x-workspace-token'] !== token)) return send(403, { error: 'Invalid request authorization' });
    const url = new URL(req.url, `http://${host}`);
    try {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
        return res.end(html);
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') return send(200, { projects: registry.list() });
      if (url.pathname === '/api/projects' && req.method === 'POST') {
        const data = await requestBody(req);
        return send(201, registry.add(data));
      }
      const match = /^\/api\/projects\/([a-f0-9]{32})$/.exec(url.pathname);
      if (match && req.method === 'DELETE') {
        if (jobs.get(match[1])?.status === 'running' || pipelineJobs.get(match[1])?.status === 'running') throw new Error('Cannot remove a project while work is running');
        return send(200, { removed: registry.remove(match[1]) });
      }
      if (match && req.method === 'GET') {
        const project = registry.resolve(match[1]);
        const configFile = path.join(project.path, 'pipeline.config.json');
        if (!fs.existsSync(configFile)) return send(200, { project, configured: false, issue: 'No pipeline.config.json found.' });
        try {
          const cfg = loadConfig(configFile);
          return send(200, { project, configured: true, config: { name: cfg.name, workspace: cfg.workspace, tracker: cfg.tracker.type, agent: cfg.agent.provider, vcs: cfg.vcs.type } });
        } catch (error) { return send(200, { project, configured: false, issue: redact(error.message) }); }
      }
      const setupMatch = /^\/api\/projects\/([a-f0-9]{32})\/setup$/.exec(url.pathname);
      if (setupMatch && req.method === 'POST') {
        if (jobs.get(setupMatch[1])?.status === 'running' || pipelineJobs.get(setupMatch[1])?.status === 'running') throw new Error('Wait for project work to finish before changing setup');
        const project = registry.resolve(setupMatch[1]);
        return send(201, setupWorkspaceProject(project.path, await requestBody(req)));
      }
      if (setupMatch && req.method === 'GET') {
        const project = registry.resolve(setupMatch[1]);
        const cfg = loadConfig(path.join(project.path, 'pipeline.config.json'));
        const agents = [...new Set(['code', 'plan', 'brain'].map((job) => providerName(cfg, job)))].map((name) => {
          try { const spec = providerSpec(name, cfg); return { name, command: spec.command, available: commandExists(spec.command) }; }
          catch (error) { return { name, available: false, error: redact(error.message) }; }
        });
        return send(200, { agents, tracker: { type: cfg.tracker.type, ready: cfg.tracker.type === 'file' ? fs.existsSync(cfg.tracker.file) : !!process.env[cfg.tracker.tokenEnv] }, qaConfigured: !!cfg.qa.command, jobsReady: fs.existsSync(cfg.jobs.coding) && (!cfg.plan.enabled || fs.existsSync(cfg.jobs.plan)), note: 'Availability checks do not verify sign-in, tracker connectivity, or whether QA is adequate.' });
      }
      const agentMatch = /^\/api\/projects\/([a-f0-9]{32})\/agents$/.exec(url.pathname);
      if (agentMatch) {
        const project = registry.resolve(agentMatch[1]);
        if (req.method === 'GET') return send(200, agentSettings(project.path));
        if (req.method === 'POST') {
          if (jobs.get(agentMatch[1])?.status === 'running' || pipelineJobs.get(agentMatch[1])?.status === 'running') throw new Error('Wait for project work to finish before changing agent settings');
          return send(200, agentSettings(project.path, await requestBody(req)));
        }
      }
      const settingsMatch = /^\/api\/projects\/([a-f0-9]{32})\/settings$/.exec(url.pathname);
      if (settingsMatch) {
        const project = registry.resolve(settingsMatch[1]);
        if (req.method === 'GET') return send(200, pipelineSettings(project.path));
        if (req.method === 'POST') {
          if (jobs.get(settingsMatch[1])?.status === 'running' || pipelineJobs.get(settingsMatch[1])?.status === 'running') throw new Error('Wait for project work to finish before changing settings');
          return send(200, pipelineSettings(project.path, await requestBody(req)));
        }
      }
      const brainMatch = /^\/api\/projects\/([a-f0-9]{32})\/brain(?:\/([a-z-]+))?$/.exec(url.pathname);
      if (brainMatch) {
        const project = registry.resolve(brainMatch[1]);
        const configFile = path.join(project.path, 'pipeline.config.json');
        const cfg = fs.existsSync(configFile) ? loadConfig(configFile) : { ...structuredClone(DEFAULTS), workspace: project.path };
        secrets = [process.env[cfg.tracker.tokenEnv]].filter(Boolean);
        const normalize = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
        if (normalize(cfg.workspace) !== normalize(project.path)) throw new Error('Project configuration points to a different workspace');
        const action = brainMatch[2] ?? 'runs';
        if (req.method === 'GET' && action === 'runs') {
          const dir = safeProjectPath(project.path, '.project-brain/runs');
          const runs = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory() && !item.isSymbolicLink() && /^[a-z0-9_-]{1,48}$/.test(item.name)).map((item) => item.name).sort() : [];
          return send(200, { runs, job: jobs.get(project.id) ?? null });
        }
        if (req.method === 'GET' && action === 'status') return send(200, brainStatus(cfg, { name: url.searchParams.get('name') || 'default' }));
        if (req.method === 'GET' && action === 'freshness') return send(200, brainFreshness(cfg, { name: url.searchParams.get('name') || 'default' }));
        if (req.method === 'GET' && action === 'evidence') {
          const findingId = url.searchParams.get('finding');
          const indexText = url.searchParams.get('index');
          if (!findingId || !/^\d{1,3}$/.test(indexText ?? '')) throw new Error('Choose a finding and evidence item');
          const report = brainFreshness(cfg, { name: url.searchParams.get('name') || 'default' });
          const finding = report.findings.find((item) => item.id === findingId);
          const evidence = finding?.evidence[Number(indexText)];
          if (!evidence) throw new Error('Evidence not found in accepted findings');
          if (!/\.(cs|cshtml|js|jsx|ts|tsx|html|css|scss|sql|md|txt|xml|json|py|java|php)$/i.test(evidence.path) || /(^|\/)(\.env[^/]*|[^/]*secret[^/]*|[^/]*credential[^/]*)$/i.test(evidence.path)) throw new Error('This file type is not available in the source viewer');
          const file = safeProjectPath(project.path, evidence.path);
          const stat = fs.statSync(file);
          if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Source must be a file no larger than 1 MiB');
          const bytes = fs.readFileSync(file);
          const hash = crypto.createHash('sha256').update(bytes).digest('hex');
          if (!evidence.currentHash || hash !== evidence.currentHash) throw new Error('Source changed while it was being inspected; retry freshness');
          const text = bytes.toString('utf8');
          if (text.includes('\0')) throw new Error('Binary files cannot be displayed');
          const lines = text.split(/\r?\n/);
          const first = evidence.startLine;
          const last = Math.min(evidence.endLine, first + 99, lines.length);
          if (!Number.isInteger(first) || !Number.isInteger(evidence.endLine) || first < 1 || first > last) throw new Error('Cited lines are no longer available in the current file');
          let remaining = 40000;
          let lineTruncated = false;
          const excerpt = [];
          for (let line = first; line <= last && remaining > 0; line++) {
            const safeLine = redact(lines[line - 1], secrets);
            const value = safeLine.slice(0, Math.min(2000, remaining));
            if (value.length < safeLine.length) lineTruncated = true;
            excerpt.push({ line, text: value }); remaining -= value.length;
          }
          return send(200, { path: evidence.path, startLine: first, endLine: evidence.endLine, freshness: finding.freshness, evidenceStatus: evidence.status, lines: excerpt, truncated: lineTruncated || last < evidence.endLine || excerpt.length < last - first + 1 });
        }
        if (req.method === 'GET' && action === 'document') {
          const kind = url.searchParams.get('kind');
          if (!['prompt', 'submission', 'synthesis'].includes(kind)) throw new Error('Unknown analysis document');
          const report = brainStatus(cfg, { name: url.searchParams.get('name') || 'default' });
          const rel = report[kind];
          if (!rel) throw new Error('This document is not available for the selected run');
          const file = safeProjectPath(project.path, rel);
          if (!fs.statSync(file).isFile() || fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Analysis document is not a file or exceeds 2 MiB');
          return send(200, { kind, path: rel, text: fs.readFileSync(file, 'utf8') });
        }
        if (req.method === 'GET' && action === 'review') return send(200, brainReview(cfg, { scope: url.searchParams.get('scope') || '.' }));
        if (req.method === 'GET' && action === 'lessons') return send(200, lessonKnowledge(cfg.workspace, cfg, { scope: url.searchParams.get('scope') || '.' }));
        if (req.method === 'GET' && action === 'duplicates') return send(200, lessonDuplicates(cfg.workspace, cfg, { scope: url.searchParams.get('scope') || '.' }));
        if (req.method === 'POST') {
          const data = await requestBody(req);
          if (action === 'init') return send(200, initBrain(cfg, { name: data.name, scope: data.scope }));
          if (action === 'analyze') return send(200, analyzeBrain(cfg, { name: data.name }));
          if (action === 'refresh') return send(200, refreshBrain(cfg, { name: data.name, to: data.to, findings: data.findings, accept: data.accept === true }));
          if (action === 'review' && ['decision.add', 'conflict.add', 'conflict.assign', 'conflict.resolve', 'conflict.reopen'].includes(data.type)) return send(200, recordReview(cfg, data.type, data.options));
          if (action === 'lesson' && ['review', 'correct', 'retire', 'duplicate'].includes(data.action)) return send(200, recordLesson(cfg.workspace, cfg, data.action, data.options));
          if (action === 'run') {
            if (jobs.get(project.id)?.status === 'running') throw new Error('An analysis is already running for this project');
            if (pipelineJobs.get(project.id)?.status === 'running') throw new Error('Wait for the pipeline to finish before running analysis');
            const job = { status: 'running', name: data.name || 'default' };
            jobs.set(project.id, job);
            runBrain(cfg, { name: data.name }).then((result) => { job.status = 'complete'; job.result = result; }).catch((error) => { job.status = 'failed'; job.error = redact(error.message); });
            return send(202, job);
          }
        }
      }
      const ticketMatch = /^\/api\/projects\/([a-f0-9]{32})\/(tickets|pipeline)(?:\/([A-Za-z0-9_-]+))?(?:\/(comment|status|action|context))?$/.exec(url.pathname);
      if (ticketMatch) {
        const project = registry.resolve(ticketMatch[1]);
        const cfg = loadConfig(path.join(project.path, 'pipeline.config.json'));
        secrets = [process.env[cfg.tracker.tokenEnv]].filter(Boolean);
        const normalize = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
        if (normalize(cfg.workspace) !== normalize(project.path)) throw new Error('Project configuration points to a different workspace');
        for (const other of registry.list().filter((p) => p.id !== project.id)) {
          const file = path.join(other.path, 'pipeline.config.json');
          if (!fs.existsSync(file)) continue;
          const otherCfg = loadConfig(file);
          if (normalize(otherCfg.stateDir) === normalize(cfg.stateDir) || (cfg.tracker.type === 'file' && otherCfg.tracker.type === 'file' && normalize(otherCfg.tracker.file) === normalize(cfg.tracker.file))) throw new Error(`Project configuration shares state or ticket storage with ${other.name}`);
        }
        const tracker = createTracker(cfg);
        const state = new State(cfg.stateDir);
        const [, , resource, id, operation] = ticketMatch;
        if (id && !isSafeId(id)) throw new Error('Invalid ticket ID');
        if (resource === 'tickets' && req.method === 'GET' && !id) return send(200, { tickets: (await tracker.list(STATUS_KEYS)).map((ticket) => ({ ...ticket, actions: ticketActions(ticket.statusKey) })), tracker: cfg.tracker.type });
        if (resource === 'tickets' && req.method === 'GET' && id && !operation) {
          const ticket = await tracker.get(id);
          return send(200, { ...ticket, actions: ticketActions(ticket.statusKey), comments: await tracker.getComments(id), plan: state.get(`plan-${id}`), pendingPlan: state.get(`plan-${id}-pending`), failure: state.get('failures', {})[id] ?? null, planFailure: state.get('plan-failures', {})[id] ?? null, context: { plan: readJson(path.join(cfg.stateDir, 'contexts', `${id}-plan.json`), null), code: readJson(path.join(cfg.stateDir, 'contexts', `${id}-code.json`), null) } });
        }
        if (resource === 'tickets' && req.method === 'GET' && id && operation === 'context') {
          const ticket = await tracker.get(id);
          const comments = (await tracker.getComments(id)).filter((comment) => !comment.startsWith('[agent-pipeline] ')).slice(-10).map((comment) => comment.slice(0, 1500));
          const job = url.searchParams.get('job') || 'plan';
          if (!['plan', 'code'].includes(job)) throw new Error('Choose plan or code context');
          const plan = job === 'plan' ? state.get(`plan-${id}`) ?? state.get(`plan-${id}-pending`)
            : cfg.plan.enabled ? state.get(`plan-${id}`) : null;
          const context = findContext(cfg.workspace, cfg, { id, title: ticket.title, description: ticket.description, comments, hintFeature: plan?.feature, paths: job === 'code' ? plan?.files ?? [] : [] });
          const index = findIndexContext(buildProjectIndex(cfg.workspace, cfg), cfg, { title: ticket.title, description: ticket.description, comments, featureContext: context });
          const fitted = fitContextBudget(context, index, cfg);
          return send(200, { ticket: id, job, manifest: fitted.manifest, note: 'Preview uses the current project workspace and ticket data. Actual context may differ, especially in a prepared worktree. The estimate covers retrieved knowledge, not the full prompt or output. The omissions list covers budget cuts after relevance and configured limits; it does not list every excluded source. Brain findings and decisions are not yet included.' });
        }
        if (resource === 'tickets' && req.method === 'POST') {
          const data = await requestBody(req);
          if (!id) {
            if (cfg.tracker.type !== 'file') throw new Error('Create this ticket in the connected tracker');
            if (!isSafeId(data.id) || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 500 || typeof data.description !== 'string' || data.description.length > 12000) throw new Error('Provide a safe ticket ID, title and description');
            const all = readJson(cfg.tracker.file, []);
            if (!Array.isArray(all) || all.some((ticket) => ticket.id === data.id)) throw new Error('Invalid ticket file or duplicate ticket ID');
            all.push({ id: data.id, title: data.title.trim(), description: data.description, status: cfg.tracker.statuses.new, comments: [] });
            writeJson(cfg.tracker.file, all);
            return send(201, { id: data.id });
          }
          if (operation === 'comment') {
            if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 12000) throw new Error('Comment must be 1–12000 characters');
            await tracker.comment(id, redact(data.text, secrets));
            return send(200, { ok: true });
          }
          if (operation === 'action') {
            if (typeof data.action !== 'string' || typeof data.expectedStatus !== 'string') throw new Error('Choose a ticket action and expected status');
            const ticket = await tracker.get(id);
            if (ticket.statusKey !== data.expectedStatus) return send(409, { error: 'Ticket status changed. Refresh the ticket list and review it again.' });
            if (state.get('inflight')?.ticketId === id) return send(409, { error: 'This ticket is being processed. Wait for the current work to finish.' });
            const action = ticketActions(ticket.statusKey).find((item) => item.id === data.action);
            if (!action) throw new Error('This action is not available for the ticket’s current status');
            await tracker.setStatus(id, action.target);
            return send(200, { ok: true, ticket: id, status: action.target });
          }
          if (operation === 'status') {
            if (!STATUS_KEYS.includes(data.status)) throw new Error('Unknown ticket status');
            await tracker.setStatus(id, data.status);
            return send(200, { ok: true });
          }
        }
        if (resource === 'pipeline' && !id && req.method === 'GET') return send(200, { paused: state.isPaused(), inflight: state.get('inflight'), events: state.recentEvents(25), job: pipelineJobs.get(project.id) ?? null });
        if (resource === 'pipeline' && !id && req.method === 'POST') {
          const data = await requestBody(req);
          if (data.action === 'pause' || data.action === 'unpause') { if (data.action === 'pause') state.pause(); else state.unpause(); return send(200, { ok: true }); }
          if (!['plan', 'code', 'all'].includes(data.action)) throw new Error('Invalid pipeline action');
          if (pipelineJobs.get(project.id)?.status === 'running') throw new Error('A pipeline tick is already running for this project');
          if (jobs.get(project.id)?.status === 'running') throw new Error('Wait for project analysis to finish before running the pipeline');
          const job = { status: 'running', action: data.action };
          pipelineJobs.set(project.id, job);
          runOnce(cfg, {}, { job: data.action }).then((result) => { job.status = 'complete'; job.result = result; }).catch((error) => { job.status = 'failed'; job.error = redact(error.message); });
          return send(202, job);
        }
      }
      return send(404, { error: 'Not found' });
    } catch (error) { return send(400, { error: redact(error.message) }); }
  });
  server.listen(port, '127.0.0.1', () => {
    if (port !== 0) console.log(`Local workspace: http://127.0.0.1:${server.address().port}`);
  });
  return server;
}

async function requestBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new Error('Request body exceeds 16 KiB');
    chunks.push(chunk);
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error('Expected JSON request');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON request'); }
}
