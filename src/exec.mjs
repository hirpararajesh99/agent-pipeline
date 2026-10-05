import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, isWin } from './util.mjs';

const winQuote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`);

function killTree(child) {
  if (!child.pid) return;
  if (isWin) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
  }
}

/**
 * Run a process with timeout, process-tree kill, log file and output tail.
 * shell=true: `command` is a full shell command line written by the pipeline owner (config).
 * shell=false: `command` + `args` are passed directly (no injection); on Windows they are quoted for cmd shims such as codex.cmd.
 */
export function run({ command, args = [], shell = false, cwd, env, input, timeoutMs = 0, logFile, onTick, tickMs = 30000 }) {
  return new Promise((resolve) => {
    const stdio = ['pipe', 'pipe', 'pipe'];
    const base = { cwd, env: env ?? process.env, stdio, detached: !isWin, windowsHide: true };
    let child;
    if (shell) child = spawn(command, { ...base, shell: true });
    else if (isWin) child = spawn([command, ...args].map(winQuote).join(' '), { ...base, shell: true });
    else child = spawn(command, args, base);

    let log = null;
    if (logFile) { ensureDir(path.dirname(logFile)); log = fs.createWriteStream(logFile, { flags: 'a' }); }
    let buf = '';
    const onData = (d) => {
      const s = d.toString();
      if (log) log.write(s);
      buf = (buf + s).slice(-32768);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');

    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    const tick = onTick ? setInterval(onTick, tickMs) : null;
    const done = (code, extra = {}) => {
      if (timer) clearTimeout(timer);
      if (tick) clearInterval(tick);
      if (log) log.end();
      resolve({ code, timedOut, tail: buf, ...extra });
    };
    child.on('error', (err) => done(127, { error: err.message }));
    child.on('close', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
}

export const runShell = (commandLine, opts = {}) => run({ ...opts, command: commandLine, shell: true });
export const runCommand = (command, args, opts = {}) => run({ ...opts, command, args });

export function commandExists(cmd) {
  const r = spawnSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}
