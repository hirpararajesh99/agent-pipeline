import fs from 'node:fs';
import { runCommand } from '../../exec.mjs';

/**
 * Agent adapter contract:
 *   input : prompt file + working directory + time limit (+ job: "plan" or "code")
 *   output: { code, timedOut, quotaHit, unavailable, tail } and whatever files the agent wrote
 * Presets are starting points. CLI flags change between versions, so any field can be overridden under
 * agent.providers.<name> (all jobs) or agent.plan.providers.<name> (planning only).
 */
export const BUILTIN = {
  codex: {
    command: 'codex',
    args: ['-a', 'never', 'exec', '--skip-git-repo-check', '-s', '{sandbox}', '{modelArgs}', '-'],
    promptMode: 'stdin',
    sandbox: 'workspace-write',
    modelArgs: ['-m', '{model}'],
  },
  claude: {
    command: 'claude',
    args: ['-p', '--permission-mode', '{permissionMode}', '--allowedTools', '{allowedTools}', '{modelArgs}'],
    promptMode: 'stdin',
    permissionMode: 'acceptEdits',
    allowedTools: 'Bash,Edit,Write,Read,Glob,Grep',
    modelArgs: ['--model', '{model}'],
    plan: { allowedTools: 'Read,Glob,Grep,Write' },
    brain: { allowedTools: 'Read,Glob,Grep,Write' },
  },
  cursor: {
    command: 'agent',
    args: ['-p', '--force', '{modelArgs}', '{promptPointer}'],
    promptMode: 'pointer',
    modelArgs: ['--model', '{model}'],
  },
};

const sub = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
const SPAWN_FAIL = /is not recognized as an internal or external command|command not found|ENOENT|no such file or directory/i;
const LOGIN_FAIL = /not logged in|please log ?in|login required|authentication (failed|required)|unauthorized|invalid api key|sign in/i;

export function providerName(cfg, job) {
  if (job === 'plan' && cfg.agent.plan.provider) return cfg.agent.plan.provider;
  if (job === 'brain' && cfg.agent.brain?.provider) return cfg.agent.brain.provider;
  return cfg.agent.provider;
}

export function providerSpec(name, cfg, job = 'code') {
  const builtin = BUILTIN[name] ?? { promptMode: 'stdin', args: [] };
  const { plan: builtinPlan, brain: builtinBrain, ...base } = builtin;
  const spec = {
    ...base,
    ...(job === 'plan' ? builtinPlan ?? {} : job === 'brain' ? builtinBrain ?? {} : {}),
    ...(cfg.agent.providers?.[name] ?? {}),
    ...(job === 'plan' ? cfg.agent.plan.providers?.[name] ?? {} : job === 'brain' ? cfg.agent.brain?.providers?.[name] ?? {} : {}),
  };
  if (!spec.command) throw new Error(`Agent provider "${name}" has no command. Define agent.providers.${name}.command in the config.`);
  return spec;
}

export function buildInvocation(name, cfg, { promptFile, cwd, ticket, job = 'code' }) {
  const spec = providerSpec(name, cfg, job);
  const model = spec.model ?? (job === 'plan' ? cfg.agent.plan.model : job === 'brain' ? cfg.agent.brain?.model : '') ?? '';
  const useModel = model || cfg.agent.model || '';
  const vars = {
    promptFile,
    promptPointer: `Read the file ${promptFile} and follow its instructions exactly.`,
    ticket,
    cwd,
    sandbox: spec.sandbox ?? '',
    permissionMode: spec.permissionMode ?? '',
    allowedTools: spec.allowedTools ?? '',
    model: useModel,
  };
  const args = (spec.args ?? []).flatMap((a) => {
    if (a === '{modelArgs}') return useModel && spec.modelArgs ? spec.modelArgs.map((m) => sub(m, vars)) : [];
    return [sub(a, vars)];
  });
  const input = spec.promptMode === 'stdin' ? fs.readFileSync(promptFile, 'utf8') : null;
  return { command: spec.command, args, input };
}

export async function runAgent(name, cfg, { promptFile, cwd, ticket, job = 'code', logFile, onTick }) {
  const inv = buildInvocation(name, cfg, { promptFile, cwd, ticket, job });
  const env = { ...process.env, ...cfg.agent.env };
  // The agent never needs tracker or deploy credentials: the pipeline owns those writes.
  for (const k of [cfg.tracker.tokenEnv, ...cfg.agent.scrubEnv]) if (k) delete env[k];
  const minutes = job === 'plan' ? cfg.agent.plan.maxMinutes : job === 'brain' ? cfg.agent.brain?.maxMinutes ?? cfg.agent.maxMinutes : cfg.agent.maxMinutes;
  const started = Date.now();
  const res = await runCommand(inv.command, inv.args, { cwd, env, input: inv.input, timeoutMs: minutes * 60000, logFile, onTick });
  const ms = Date.now() - started;
  const failed = res.code !== 0 && !res.timedOut;
  const patterns = cfg.agent.quotaPatterns.map((p) => new RegExp(p, 'i'));
  const quotaHit = failed && patterns.some((re) => re.test(res.tail));
  // A tool that is missing or logged out fails almost instantly; a real coding run does not.
  let unavailable = null;
  if (failed && !quotaHit && (res.code === 127 || ms < 20000)) {
    if (res.code === 127 || SPAWN_FAIL.test(res.tail)) unavailable = `The "${inv.command}" program could not be started. Install it and add it to PATH.`;
    else if (LOGIN_FAIL.test(res.tail)) unavailable = `The "${inv.command}" program is not signed in. Run it once and log in.`;
  }
  return { ...res, quotaHit, unavailable, command: inv.command, ms };
}
