import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson } from './util.mjs';

/** Small JSON state store. Every write is atomic. */
export class State {
  constructor(dir) {
    this.dir = dir;
    ensureDir(dir);
  }
  file(name) { return path.join(this.dir, `${name}.json`); }
  get(name, fallback = null) { return readJson(this.file(name), fallback); }
  set(name, value) { writeJson(this.file(name), value); }
  isPaused() { return fs.existsSync(path.join(this.dir, 'PAUSE')); }
  pause() { fs.writeFileSync(path.join(this.dir, 'PAUSE'), new Date().toISOString()); }
  unpause() { try { fs.unlinkSync(path.join(this.dir, 'PAUSE')); } catch { /* not paused */ } }
  event(event, data = {}) {
    fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n');
  }
  recentEvents(n = 5) {
    try {
      return fs.readFileSync(path.join(this.dir, 'events.jsonl'), 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l));
    } catch { return []; }
  }
}
