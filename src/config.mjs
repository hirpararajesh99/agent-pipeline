import path from 'node:path';
import { readJson } from './util.mjs';

export const STATUS_KEYS = ['new', 'planning', 'approval', 'ready', 'redo', 'resume', 'inDevelopment', 'parked', 'testing', 'pass', 'signOff', 'blocked', 'needInfo'];

export const DEFAULTS = {
  name: 'agent-pipeline',
  workspace: '.',
  stateDir: '.pipeline-state',
  jobs: { coding: 'jobs/coding.md', plan: 'jobs/plan.md' },
  rules: [],
  agent: {
    provider: 'codex',
    fallback: [],
    model: '',
    maxMinutes: 50,
    providers: {},
    env: {},
    scrubEnv: [],
    quotaPatterns: ['rate limit', 'usage limit', 'quota', 'too many requests', '\\b429\\b'],
    plan: { provider: '', model: '', maxMinutes: 20, providers: {} },
  },
  tracker: {
    type: 'file',
    file: 'tickets.json',
    tokenEnv: 'CLICKUP_API_TOKEN',
    listId: '',
    tags: [],
    assignees: [],
    skipTags: [],
    statuses: {
      new: 'not started',
      planning: 'planning',
      approval: 'needs approval',
      ready: 'code ready',
      redo: 'redo',
      resume: 'resume',
      inDevelopment: 'in development',
      parked: 'development completed',
      testing: 'ai testing',
      pass: 'ai test pass',
      signOff: 'sign off',
      blocked: 'blocked',
      needInfo: 'need info',
    },
  },
  vcs: {
    type: 'none',
    baseBranch: 'main',
    mode: 'worktree',
    worktreeRoot: '.pipeline-state/worktrees',
    branchPrefix: 'ai/',
    push: true,
    prCommand: '',
    prepare: '',
    addCommand: '',
    addIgnoreFailure: true,
    checkinCommand: '',
    refPattern: '',
  },
  gates: { build: '', unitTests: '', timeoutMinutes: 30 },
  artifacts: { dir: '.pipeline/tickets/{ticket}', requireQaAssert: true },
  qa: { command: '', timeoutMinutes: 30, exitCodes: { pass: 0, fail: 2, blocked: 3 } },
  deploy: { command: '', smokeCommand: '', batchMin: 10, timeoutMinutes: 60 },
  limits: { maxAttempts: 3, pauseReadyWhenRedoAtLeast: 5, lockStaleMinutes: 120, quotaHoldMinutes: 60, unavailableHoldMinutes: 15 },
  plan: {
    enabled: true,
    perTick: 2,
    snapshotGuard: true,
    requireQaCoverage: true,
    ignore: ['node_modules', '.git', 'bin', 'obj', '.vs', '.idea', 'dist', 'build', '.pipeline', '.pipeline-state'],
  },
  docs: {
    featuresDir: 'docs/features',
    lessonsDir: 'docs/memory/lessons',
    memoryIndex: 'docs/memory/INDEX.md',
    featureIndex: 'docs/FEATURES.md',
    requireUpdate: true,
    requireLessonOnRedo: true,
    changelog: true,
    maxFeatures: 3,
    maxLessons: 3,
  },
  comments: { onFailure: true, onPlan: true },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

export function buildConfig(raw, baseDir) {
  const cfg = deepMerge(structuredClone(DEFAULTS), raw);
  cfg.baseDir = baseDir;
  cfg.workspace = path.resolve(baseDir, cfg.workspace);
  cfg.stateDir = path.resolve(baseDir, cfg.stateDir);
  cfg.vcs.worktreeRoot = path.resolve(baseDir, cfg.vcs.worktreeRoot);
  cfg.jobs.coding = path.resolve(baseDir, cfg.jobs.coding);
  cfg.jobs.plan = path.resolve(baseDir, cfg.jobs.plan);
  if (cfg.tracker.type === 'file') cfg.tracker.file = path.resolve(baseDir, cfg.tracker.file);
  validate(cfg);
  return cfg;
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  const raw = readJson(abs, undefined);
  if (raw === undefined) throw new Error(`Config not found: ${abs}. Run "agent-pipeline init" first.`);
  return buildConfig(raw, path.dirname(abs));
}

function validate(cfg) {
  const errs = [];
  if (!['file', 'clickup'].includes(cfg.tracker.type)) errs.push(`tracker.type "${cfg.tracker.type}" is not supported (file, clickup)`);
  if (!['none', 'git', 'command'].includes(cfg.vcs.type)) errs.push(`vcs.type "${cfg.vcs.type}" is not supported (none, git, command)`);
  for (const k of STATUS_KEYS) if (!cfg.tracker.statuses[k]) errs.push(`tracker.statuses.${k} is missing`);
  if (cfg.tracker.type === 'clickup' && !cfg.tracker.listId) errs.push('tracker.listId is required for clickup');
  if (!cfg.qa.command) errs.push('qa.command is required: the pipeline never checks in without a QA run');
  if (cfg.vcs.type === 'command' && !cfg.vcs.checkinCommand) errs.push('vcs.checkinCommand is required for vcs.type "command"');
  if (!(cfg.limits.maxAttempts >= 1)) errs.push('limits.maxAttempts must be >= 1');
  if (errs.length) throw new Error(`Invalid config:\n - ${errs.join('\n - ')}`);
}
