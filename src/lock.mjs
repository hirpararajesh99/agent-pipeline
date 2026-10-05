import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, ensureDir } from './util.mjs';

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function isStale(file, staleMs) {
  let info;
  try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return true; }
  if (info.host === os.hostname() && !pidAlive(info.pid)) return true;
  return Date.now() - (info.heartbeat ?? 0) > staleMs;
}

/** Single-instance lock with heartbeat and stale-lock recovery. Returns null if another run holds it. */
export function acquireLock(file, { name = 'run', staleMs = 2 * 60 * 60 * 1000 } = {}) {
  ensureDir(path.dirname(file));
  const body = () => JSON.stringify({ name, pid: process.pid, host: os.hostname(), startedAt: Date.now(), heartbeat: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, body());
      fs.closeSync(fd);
      return {
        beat() { try { atomicWrite(file, body()); } catch { /* best effort */ } },
        release() { try { fs.unlinkSync(file); } catch { /* already gone */ } },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (isStale(file, staleMs)) { try { fs.unlinkSync(file); } catch { /* raced */ } continue; }
      return null;
    }
  }
  return null;
}
