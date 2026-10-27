import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, STATUS_KEYS, DEFAULTS } from './config.mjs';
import { initBrain, analyzeBrain, brainStatus, brainFreshness, runBrain } from './brain.mjs';
import { refreshBrain } from './brain-refresh.mjs';
import { brainReview, recordReview, runReviewSnapshot } from './brain-review.mjs';
import { lessonKnowledge, lessonDuplicates, recordLesson } from './brain-lessons.mjs';
import { providerName, providerSpec } from './adapters/agents/index.mjs';
import { createTracker } from './adapters/trackers/index.mjs';
import { commandExists } from './exec.mjs';
import { findContext, isFeatureSlug, rebuildFeatureIndex, seedReadme, slugify } from './docs.mjs';
import { buildProjectIndex, findImpact, writeProjectIndex } from './indexer.mjs';
import { runOnce } from './orchestrator.mjs';
import { State } from './state.mjs';
import { readJson, redact, sleep, writeJson } from './util.mjs';

const HELP = `agent-pipeline - plan, code, verify, test and document tickets with any AI coding tool

Usage: agent-pipeline <command> [options]

Setup
  init                          Create starter config, AGENTS.md, job files, docs/ skeleton, tickets.json
  doctor                        Check Node, config, AI tool, tracker, QA command, docs folders

Run
  run [--job plan|code|all]     One scheduler tick (default: all). Add --dry-run to only show what it would do
  loop [--interval N]           Repeat "run" every N minutes (default 15)
  serve [--port N]              Start the browser dashboard (default port 3000)
  status                        Pause flag, locks, in-flight ticket, deploy queue, holds, recent events
  pause | unpause               Stop or allow new ticks

Tickets (file tracker; set works with ClickUp too)
  ticket add --title T [--description D] [--status new|ready] [--id ID]
  ticket list                   All tickets with status
  ticket show <id>              Ticket, comments and its plan
  ticket comment <id> <text>    Add a human comment (answers to questions go here)
  ticket set <id> <statusKey>   Move a ticket, for example: ticket set T-1 resume
                                keys: ${STATUS_KEYS.join(', ')}

Docs
  docs find "<text>"            Show which feature docs and lessons an agent would be told to read
  docs index                    Rebuild docs/FEATURES.md from the feature READMEs
  docs scan                     Generate the project file index and reference graph
  docs impact <path>            Show direct indexed relationships for a project file or asset
  docs scaffold <slug> [--title T]   Create docs/features/<slug>/README.md to fill in

Project Brain
  brain init [--name NAME] [--scope PATH]  Bootstrap analysis (default name: default, scope: .)
  brain status [--name NAME]              Verify snapshot and show the next prompt
  brain freshness [--name NAME]           Compare accepted findings with current source (no AI)
  brain refresh --name SOURCE --to NEW    Prepare review of stale findings in a new run
                                --findings ID,ID selects only those IDs (default: all stale findings)
  brain refresh --name NEW --accept      Accept a reviewed refresh submission
  brain knowledge [--scope PATH]         Show developer decisions, conflicts and history
  brain decision add|list|show           Record rationale; add requires --id --by --statement --reason
                                optional: --scope PATH --supersedes ID --findings RUN:ID
  brain conflict add|list|show           Record disagreement; add requires --id --by --summary --left --right
                                optional: --scope PATH --owner NAME --findings RUN:ID --decisions ID
  brain conflict resolve                --id ID --by OWNER --resolution TEXT --reason TEXT [--decision ID]
  brain conflict assign|reopen           --id ID --by NAME --reason TEXT (assign also needs --owner)
  brain lesson list|duplicates           [--scope PATH] Inspect lessons or possible duplicates
  brain lesson show                     --file PATH Show current revision and preserved history
  brain lesson review                   --file PATH --by NAME --reason TEXT --applicability TEXT
                                optional: --scope PATH --evidence PATH,PATH (empty clears evidence)
  brain lesson correct                  --file PATH --by NAME --reason TEXT --rule TEXT
                                optional: --scope PATH --applicability TEXT --evidence PATH,PATH
  brain lesson retire                   --file PATH --by NAME --reason TEXT
  brain lesson duplicate                --file PATH --by NAME --reason TEXT --duplicate-of PATH
  brain analyze [--name NAME]             Accept the next agent submission and render findings
  brain run [--name NAME]                 Run all remaining stages with the configured AI provider

Options
  --config <file>               Config path (default: PIPELINE_CONFIG or ./pipeline.config.json)
`;

function parse(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['dry-run', 'once', 'accept'].includes(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}

export async function main(argv) {
  const { flags, pos } = parse(argv);
  const cmd = pos[0] ?? 'help';
  const cfgPath = flags.config ?? process.env.PIPELINE_CONFIG ?? 'pipeline.config.json';
  if (cmd === 'help' || cmd === '--help') return console.log(HELP);
  if (cmd === 'init') return init();
  if (cmd === 'brain') {
    // Standalone analysis needs no tracker, QA command, or AI CLI configuration.
    const brainCfg = fs.existsSync(cfgPath) || flags.config || process.env.PIPELINE_CONFIG
      ? loadConfig(cfgPath) : { ...structuredClone(DEFAULTS), workspace: process.cwd() };
    return brainCmd(brainCfg, pos.slice(1), flags);
  }

  const cfg = loadConfig(cfgPath);
  if (cmd === 'doctor') return doctor(cfg);
  if (cmd === 'status') return status(cfg);
  if (cmd === 'pause') { new State(cfg.stateDir).pause(); return console.log('Paused.'); }
  if (cmd === 'unpause') { new State(cfg.stateDir).unpause(); return console.log('Unpaused.'); }
  if (cmd === 'docs') return docsCmd(cfg, pos.slice(1), flags);
  if (cmd === 'ticket') return ticketCmd(cfg, pos.slice(1), flags);
  if (cmd === 'serve') return (await import('./server.mjs')).createServer(cfg, { port: Number(flags.port ?? 3000) });
  if (cmd === 'run') return console.log(JSON.stringify(await runOnce(cfg, {}, { dryRun: !!flags['dry-run'], job: flags.job ?? 'all' }), null, 2));
  if (cmd === 'loop') {
    const minutes = Number(flags.interval ?? 15);
    let stop = false;
    process.on('SIGINT', () => { stop = true; console.log('\nStopping after the current tick...'); });
    while (!stop) {
      const r = await runOnce(cfg, {}, { job: flags.job ?? 'all' });
      console.log(`${new Date().toISOString()} ${JSON.stringify(r)}`);
      for (let s = 0; s < minutes * 60 && !stop; s++) await sleep(1000);
    }
    return;
  }
  console.log(HELP);
  process.exitCode = 1;
}

function copyTree(from, to, report) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const f = path.join(from, e.name);
    const t = path.join(to, e.name);
    if (e.isDirectory()) copyTree(f, t, report);
    else if (fs.existsSync(t)) report(`kept    ${path.relative('.', t)}`);
    else { fs.mkdirSync(path.dirname(t), { recursive: true }); fs.copyFileSync(f, t); report(`created ${path.relative('.', t)}`); }
  }
}

function init() {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
  const report = (l) => console.log(l);
  const one = (from, to) => {
    if (fs.existsSync(to)) return report(`kept    ${to}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, from), to);
    report(`created ${to}`);
  };
  one('pipeline.config.example.json', 'pipeline.config.json');
  one('AGENTS.md', 'AGENTS.md');
  one('tickets.example.json', 'tickets.json');
  copyTree(path.join(src, 'jobs'), 'jobs', report);
  copyTree(path.join(src, 'docs'), 'docs', report);
  console.log('\nNext: edit pipeline.config.json, then run "agent-pipeline doctor".');
}

function status(cfg) {
  const state = new State(cfg.stateDir);
  const lock = (n) => { const l = readJson(path.join(cfg.stateDir, `${n}.lock`), null); return l ? { pid: l.pid, host: l.host } : null; };
  const holds = fs.readdirSync(cfg.stateDir).filter((f) => f.startsWith('hold-')).map((f) => {
    const k = f.replace(/\.json$/, '');
    const h = state.get(k);
    return `${k.slice(5)}: ${h.reason} until ${new Date(h.until).toISOString()}`;
  });
  console.log(JSON.stringify({
    paused: state.isPaused(),
    locks: { code: lock('code'), plan: lock('plan') },
    inflight: state.get('inflight'),
    deployReady: state.get('deploy-ready', []).length,
    heldTickets: state.get('hold', []),
    providerHolds: holds,
    recentEvents: state.recentEvents(6),
  }, null, 2));
}

async function docsCmd(cfg, args) {
  const sub = args[0];
  if (sub === 'index') return console.log(`Wrote ${rebuildFeatureIndex(cfg.workspace, cfg)}`);
  if (sub === 'scan') {
    const index = buildProjectIndex(cfg.workspace, cfg);
    const files = writeProjectIndex(cfg.workspace, cfg, index);
    return console.log(`Indexed ${index.files.length} files and ${index.graph.edges.length} relationships:\n${files.join('\n')}`);
  }
  if (sub === 'impact') {
    const requested = args[1];
    if (!requested) throw new Error('Usage: docs impact <relative/path>');
    return console.log(JSON.stringify(findImpact(buildProjectIndex(cfg.workspace, cfg), requested), null, 2));
  }
  if (sub === 'find') {
    const text = args.slice(1).join(' ');
    if (!text) throw new Error('Usage: docs find "<ticket text>"');
    const ctx = findContext(cfg.workspace, cfg, { title: text, description: '', comments: [] });
    return console.log(JSON.stringify(ctx, null, 2));
  }
  if (sub === 'scaffold') {
    const slug = args[1];
    if (!isFeatureSlug(slug)) throw new Error('Usage: docs scaffold <lowercase-slug> [--title "Display name"]');
    const { flags } = parse(args);
    const r = seedReadme(cfg.workspace, cfg, { feature: slug, title: flags.title ?? slug, keywords: [slug.replace(/-/g, ' ')], files: [] });
    return console.log(`${r.created ? 'Created' : 'Already exists'}: ${r.rel}`);
  }
  console.log('Usage: docs find "<text>" | docs index | docs scan | docs impact <path> | docs scaffold <slug>');
}

async function brainCmd(cfg, args, flags) {
  if (args[0] === 'lesson') return lessonCmd(cfg, args, flags);
  if (['knowledge', 'decision', 'conflict'].includes(args[0])) return reviewCmd(cfg, args, flags);
  if (args.length !== 1 || !['init', 'status', 'freshness', 'refresh', 'analyze', 'run'].includes(args[0])) throw new Error('Usage: brain init|status|freshness|analyze|run [--name NAME] | brain refresh --name SOURCE --to NEW | brain refresh --name NEW --accept');
  if (flags.scope !== undefined && args[0] !== 'init') throw new Error('--scope is only valid for brain init');
  if (Object.hasOwn(flags, 'findings') && typeof flags.findings !== 'string') throw new Error('--findings requires a comma-separated list of IDs');
  if (args[0] === 'refresh') return console.log(JSON.stringify(refreshBrain(cfg, {
    name: flags.name, to: flags.to, accept: !!flags.accept,
    findings: flags.findings === undefined ? [] : flags.findings.split(','),
  }), null, 2));
  if (['to', 'findings', 'accept'].some((key) => Object.hasOwn(flags, key))) throw new Error('--to, --findings and --accept are only valid for brain refresh');
  if (args[0] === 'run') return console.log(JSON.stringify(await runBrain(cfg, { name: flags.name }), null, 2));
  const command = { init: initBrain, status: brainStatus, freshness: brainFreshness, analyze: analyzeBrain }[args[0]];
  const result = command(cfg, { name: flags.name, scope: flags.scope });
  if (['status', 'freshness'].includes(args[0])) result.review = runReviewSnapshot(cfg, flags.name);
  console.log(reviewJson(result));
}

function reviewJson(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'string' ? redact(item) : item, 2);
}

async function lessonCmd(cfg, args, flags) {
  const action = args[1];
  const options = {
    list: ['scope'], duplicates: ['scope'], show: ['file'],
    review: ['file', 'by', 'reason', 'applicability', 'scope', 'evidence'],
    correct: ['file', 'by', 'reason', 'rule', 'applicability', 'scope', 'evidence'],
    retire: ['file', 'by', 'reason'], duplicate: ['file', 'by', 'reason', 'duplicate-of'],
  };
  if (args.length !== 2 || !Object.hasOwn(options, action)) throw new Error('Usage: brain lesson list|show|duplicates|review|correct|retire|duplicate');
  for (const key of Object.keys(flags)) if (!['config', ...options[action]].includes(key) || typeof flags[key] !== 'string') {
    throw new Error(`Invalid or missing lesson option: --${key}`);
  }
  if (action === 'show' && !flags.file) throw new Error('lesson show requires --file');
  const input = { ...flags, evidence: flags.evidence === undefined ? undefined : flags.evidence === '' ? [] : flags.evidence.split(',') };
  const result = action === 'duplicates' ? lessonDuplicates(cfg.workspace, cfg, input)
    : ['list', 'show'].includes(action) ? lessonKnowledge(cfg.workspace, cfg, input)
    : recordLesson(cfg.workspace, cfg, action, input);
  console.log(reviewJson(result));
}

async function reviewCmd(cfg, args, flags) {
  const [kind, action] = args;
  const allowed = ['config'];
  if (kind === 'knowledge' || action === 'list') allowed.push('scope');
  else if (action === 'show') allowed.push('id', 'scope');
  else if (action === 'add') allowed.push('id', 'by', 'scope', 'findings', 'decisions',
    ...(kind === 'decision' ? ['statement', 'reason', 'supersedes'] : ['summary', 'left', 'right', 'owner']));
  else allowed.push('id', 'by', 'reason', ...(action === 'resolve' ? ['resolution', 'decision'] : action === 'assign' ? ['owner'] : []));
  for (const key of Object.keys(flags)) if (!allowed.includes(key) || flags[key] === undefined) throw new Error(`Invalid or missing review option: --${key}`);
  if (kind === 'knowledge') {
    if (args.length !== 1) throw new Error('Usage: brain knowledge [--scope PATH]');
    return console.log(reviewJson(brainReview(cfg, { scope: flags.scope })));
  }
  if (args.length !== 2 || !(kind === 'decision' ? ['add', 'list', 'show'] : ['add', 'list', 'show', 'resolve', 'assign', 'reopen']).includes(action)) {
    throw new Error('Usage: brain decision add|list|show | brain conflict add|list|show|resolve|assign|reopen');
  }
  if (['list', 'show'].includes(action)) {
    const view = brainReview(cfg, { scope: flags.scope });
    const records = kind === 'decision' ? view.decisions : view.conflicts;
    const result = action === 'list' ? records : records.find((r) => r.id === flags.id);
    if (!result) throw new Error('Unknown review ID; use --id with show');
    return console.log(reviewJson(result));
  }
  const list = (key) => flags[key] === undefined ? [] : flags[key].split(',').map((s) => s.trim());
  const result = recordReview(cfg, `${kind}.${action}`, { ...flags, findings: list('findings'), decisions: list('decisions') });
  console.log(reviewJson(result));
}

async function ticketCmd(cfg, args, flags) {
  const sub = args[0];
  if (sub === 'add') {
    if (cfg.tracker.type !== 'file') throw new Error('ticket add only works with the file tracker. Create tickets in your tracker instead.');
    if (!flags.title) throw new Error('Usage: ticket add --title "..." [--description "..."] [--status new|ready]');
    const all = readJson(cfg.tracker.file, []);
    const id = flags.id ?? `T-${all.length + 1}`;
    if (all.some((t) => t.id === id)) throw new Error(`Ticket ${id} already exists`);
    const key = flags.status ?? 'new';
    if (!STATUS_KEYS.includes(key)) throw new Error(`Unknown status key "${key}"`);
    all.push({ id, title: flags.title, description: flags.description ?? '', status: cfg.tracker.statuses[key], comments: [] });
    writeJson(cfg.tracker.file, all);
    return console.log(`Added ${id} as "${cfg.tracker.statuses[key]}"`);
  }
  const tracker = createTracker(cfg);
  const state = new State(cfg.stateDir);
  if (sub === 'list') {
    if (cfg.tracker.type !== 'file') throw new Error('ticket list only works with the file tracker.');
    for (const t of readJson(cfg.tracker.file, [])) console.log(`${t.id.padEnd(12)} ${t.status.padEnd(22)} ${t.title}`);
    return;
  }
  if (sub === 'show') {
    const t = await tracker.get(args[1]);
    return console.log(JSON.stringify({ ...t, comments: await tracker.getComments(t.id), plan: state.get(`plan-${t.id}`), pendingPlan: state.get(`plan-${t.id}-pending`) }, null, 2));
  }
  if (sub === 'comment') {
    if (!args[1] || !args[2]) throw new Error('Usage: ticket comment <id> <text>');
    await tracker.comment(args[1], args.slice(2).join(' '));
    return console.log('Comment added.');
  }
  if (sub === 'set') {
    if (!args[1] || !STATUS_KEYS.includes(args[2])) throw new Error(`Usage: ticket set <id> <${STATUS_KEYS.join('|')}>`);
    await tracker.setStatus(args[1], args[2]);
    return console.log(`${args[1]} -> ${cfg.tracker.statuses[args[2]]}`);
  }
  console.log('Usage: ticket add | list | show <id> | comment <id> <text> | set <id> <statusKey>');
}

function doctor(cfg) {
  let bad = 0;
  const check = (ok, label, hint = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && hint ? ` - ${hint}` : ''}`);
    if (!ok) bad++;
  };
  const major = Number(process.versions.node.split('.')[0]);
  check(major >= 18, `Node ${process.versions.node}`, 'need Node 18.17 or newer');
  check(fs.existsSync(cfg.workspace), `workspace ${cfg.workspace}`);
  check(fs.existsSync(cfg.jobs.coding), `coding job file ${cfg.jobs.coding}`);
  if (cfg.plan.enabled) {
    check(fs.existsSync(cfg.jobs.plan), `plan job file ${cfg.jobs.plan}`);
    check(fs.existsSync(path.join(cfg.workspace, cfg.docs.featuresDir)), `docs folder ${cfg.docs.featuresDir}`, 'run "agent-pipeline init" or create it');
  }
  const names = new Set([providerName(cfg, 'code'), providerName(cfg, 'plan'), ...cfg.agent.fallback]);
  for (const name of names) {
    try {
      const spec = providerSpec(name, cfg);
      check(commandExists(spec.command), `agent "${name}" command "${spec.command}" on PATH`, 'install it and sign in once');
    } catch (e) { check(false, `agent "${name}"`, e.message); }
  }
  if (cfg.tracker.type === 'clickup') check(!!process.env[cfg.tracker.tokenEnv], `env ${cfg.tracker.tokenEnv} set`);
  else check(fs.existsSync(cfg.tracker.file), `tickets file ${cfg.tracker.file}`);
  if (cfg.vcs.type === 'git') check(commandExists('git'), 'git on PATH');
  for (const [label, cmd] of [['gates.build', cfg.gates.build], ['gates.unitTests', cfg.gates.unitTests], ['qa.command', cfg.qa.command], ['deploy.command', cfg.deploy.command]]) {
    if (!cmd) continue;
    const first = cmd.trim().startsWith('"') ? cmd.trim().slice(1).split('"')[0] : cmd.trim().split(/\s+/)[0];
    check(fs.existsSync(first) || commandExists(first), `${label} program "${first}"`);
  }
  console.log(bad ? `\n${bad} problem(s) found.` : '\nAll checks passed.');
  process.exitCode = bad ? 1 : 0;
}
export { slugify };
