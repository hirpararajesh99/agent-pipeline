import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { buildConfig, deepMerge, DEFAULTS } from './config.mjs';
import { atomicWrite, redact, safeProjectPath } from './util.mjs';

const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Edit common pipeline settings while keeping unrelated and sensitive values intact. */
export function pipelineSettings(root, update) {
  const file = safeProjectPath(root, 'pipeline.config.json');
  const original = fs.readFileSync(file, 'utf8');
  let raw;
  try { raw = JSON.parse(original.replace(/^\uFEFF/, '')); } catch { throw new Error('Invalid project configuration'); }
  buildConfig(raw, root);
  const current = deepMerge(structuredClone(DEFAULTS), raw);
  const secrets = [process.env[current.tracker.tokenEnv]].filter(Boolean);
  const keys = {
    tracker: ['type', 'file', 'listId', 'tokenEnv'], vcs: ['type', 'baseBranch', 'push', 'prepare', 'checkinCommand'],
    qa: ['command'], gates: ['build', 'unitTests'], deploy: ['command', 'smokeCommand'],
    knowledge: ['maxPromptContextTokens'],
  };
  if (!update) {
    const values = {};
    for (const [section, names] of Object.entries(keys)) {
      values[section] = {};
      for (const key of names) {
        const value = current[section][key];
        values[section][key] = typeof value === 'string' && redact(value, secrets) !== value ? null : value;
      }
    }
    return { version: digest(original), values };
  }
  if (update.version !== digest(original)) throw new Error('Configuration changed since it was loaded; reload settings and retry');
  if (!update.values || typeof update.values !== 'object' || Array.isArray(update.values)) throw new Error('Invalid settings');
  for (const [section, data] of Object.entries(update.values)) {
    if (!Object.hasOwn(keys, section) || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Unknown settings section');
    raw[section] = { ...(raw[section] ?? {}) };
    for (const [key, value] of Object.entries(data)) {
      if (!keys[section].includes(key)) throw new Error('Unknown setting');
      const previous = current[section][key];
      const protectedValue = typeof previous === 'string' && redact(previous, secrets) !== previous;
      if (value === null && protectedValue) continue;
      if (key === 'push') { if (typeof value !== 'boolean') throw new Error('Git push must be true or false'); }
      else if (key === 'maxPromptContextTokens') { if (!Number.isSafeInteger(value) || value < 1) throw new Error('Context budget must be a positive whole number'); }
      else if (typeof value !== 'string' || value.length > 4000) throw new Error('Setting must be text of at most 4000 characters');
      raw[section][key] = value;
    }
  }
  buildConfig(raw, root);
  if (digest(fs.readFileSync(file, 'utf8')) !== update.version) throw new Error('Configuration changed since it was loaded; reload settings and retry');
  atomicWrite(file, JSON.stringify(raw, null, 2) + '\n');
  return { ok: true };
}

/** Edit only agent selections while preserving all other project configuration. */
export function agentSettings(root, update) {
  const file = safeProjectPath(root, 'pipeline.config.json');
  const original = fs.readFileSync(file, 'utf8');
  let raw;
  try { raw = JSON.parse(original.replace(/^\uFEFF/, '')); } catch { throw new Error('Invalid project configuration'); }
  const cfg = buildConfig(raw, root);
  if (!update) return { version: digest(original), code: cfg.agent.provider, plan: cfg.agent.plan.provider || '', brain: cfg.agent.brain.provider || '', configured: Object.keys(cfg.agent.providers ?? {}) };
  if (update.version !== digest(original)) throw new Error('Configuration changed since it was loaded; reload settings and retry');
  const available = new Set(['codex', 'claude', 'cursor', ...Object.keys(cfg.agent.providers ?? {}), cfg.agent.provider, cfg.agent.plan.provider, cfg.agent.brain.provider]);
  for (const [key, value] of Object.entries({ code: update.code, plan: update.plan, brain: update.brain })) {
    if (typeof value !== 'string' || (key === 'code' && !value) || (value && !available.has(value))) throw new Error(`Choose a configured ${key} agent`);
  }
  raw.agent = { ...(raw.agent ?? {}), provider: update.code,
    plan: { ...(raw.agent?.plan ?? {}), provider: update.plan },
    brain: { ...(raw.agent?.brain ?? {}), provider: update.brain } };
  buildConfig(raw, root);
  if (digest(fs.readFileSync(file, 'utf8')) !== update.version) throw new Error('Configuration changed since it was loaded; reload settings and retry');
  atomicWrite(file, JSON.stringify(raw, null, 2) + '\n');
  return { code: update.code, plan: update.plan, brain: update.brain };
}

/** Explicit first-time setup. Existing project files are kept, never overwritten. */
export function setupWorkspaceProject(root, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid setup data');
  const provider = input.provider;
  if (!['codex', 'claude', 'cursor', 'custom'].includes(provider)) throw new Error('Choose a supported agent');
  if (provider === 'custom' && (typeof input.customCommand !== 'string' || !input.customCommand.trim() || input.customCommand.length > 1000 || !Array.isArray(input.customArgs) || input.customArgs.length > 50 || input.customArgs.some((arg) => typeof arg !== 'string' || arg.length > 2000) || !['stdin', 'pointer'].includes(input.promptMode))) throw new Error('Provide a custom command, argument list, and prompt mode');
  if (provider === 'custom' && input.promptMode === 'pointer' && !input.customArgs.some((arg) => /\{prompt(?:Pointer|File)\}/.test(arg))) throw new Error('Pointer-mode agents need a {promptPointer} or {promptFile} argument');
  if (typeof input.qaCommand !== 'string' || !input.qaCommand.trim() || input.qaCommand.length > 4000) throw new Error('Enter a real QA command');
  if (!['file', 'clickup'].includes(input.tracker)) throw new Error('Choose a supported tracker');
  if (!['none', 'git'].includes(input.vcs)) throw new Error('Choose manual or Git version control');
  if (input.tracker === 'clickup' && (typeof input.listId !== 'string' || !input.listId.trim())) throw new Error('Enter a ClickUp list ID');
  const configFile = safeProjectPath(root, 'pipeline.config.json');
  if (fs.existsSync(configFile)) throw new Error('Configuration already exists; setup will not overwrite it');
  const raw = {
    name: path.basename(root), workspace: '.', stateDir: '.pipeline-state',
    agent: provider === 'custom' ? { provider, providers: { custom: { command: input.customCommand.trim(), args: input.customArgs, promptMode: input.promptMode } } } : { provider },
    tracker: input.tracker === 'clickup' ? { type: 'clickup', listId: input.listId.trim() } : { type: 'file', file: 'tickets.json' },
    vcs: { type: input.vcs, push: false },
    qa: { command: input.qaCommand.trim() },
  };
  buildConfig(raw, root);
  const created = [], kept = [];
  function create(relative, content) {
    const target = safeProjectPath(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    safeProjectPath(root, relative);
    try { fs.writeFileSync(target, content, { flag: 'wx' }); created.push(relative); }
    catch (error) { if (error.code === 'EEXIST') kept.push(relative); else throw error; }
  }
  for (const rel of ['AGENTS.md', 'jobs/coding.md', 'jobs/plan.md', 'docs/README.md', 'docs/memory/TEMPLATE.md', 'docs/memory/INDEX.md', 'docs/features/_TEMPLATE/README.md']) {
    create(rel, fs.readFileSync(path.join(templateRoot, ...rel.split('/'))));
  }
  if (input.tracker === 'file') create('tickets.json', '[]\n');
  // Write config last, so an interrupted setup can safely be retried.
  try { fs.writeFileSync(configFile, JSON.stringify(raw, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Configuration was created by another process; nothing was overwritten'); throw error; }
  created.push('pipeline.config.json');
  return { created, kept, note: 'Setup created no sample ticket. Check the agent, tracker, and QA command before running work.' };
}
