import fs from 'node:fs';
import crypto from 'node:crypto';
import { State } from './state.mjs';
import { acquireLock } from './lock.mjs';
import { safeProjectPath as safe } from './util.mjs';

const BASE = '.project-brain/lessons';
const MAX = 16 * 1024 * 1024;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const digest = (value) => hash(JSON.stringify(value));
const overlaps = (a, b) => a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const actions = ['review', 'correct', 'retire', 'duplicate'];

function text(value, label, max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid lesson ${label}`);
}

function context(root, cfg) {
  root = fs.realpathSync(root);
  const dir = safe(root, BASE);
  safe(dir, 'records.json'); safe(dir, 'lessons.lock');
  const lessons = String(cfg.docs.lessonsDir).replace(/\\/g, '/');
  safe(root, lessons);
  return { root, dir, lessons };
}

function lessonPath(ctx, file) {
  const abs = safe(ctx.root, file);
  if (!file.startsWith(`${ctx.lessons}/`) || !file.endsWith('.md')) throw new Error('Lesson must be a Markdown file inside docs.lessonsDir');
  return abs;
}

function scopePath(ctx, scope) {
  if (scope !== '.') safe(ctx.root, scope);
  return scope;
}

function readBytes(file, limit = 1024 * 1024) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > limit) throw new Error('Lesson input is not a regular file or exceeds its size limit');
  return fs.readFileSync(file);
}

const readFile = (file) => readBytes(file).toString('utf8');

function ruleFrom(source) {
  const rule = /^## Rule\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(source)?.[1]?.trim();
  text(rule, 'rule (expected a ## Rule section)');
  return rule;
}

// Each event carries a complete immutable revision. Replay verifies history and transitions.
function replay(ctx, data) {
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.events)) throw new Error('Invalid lesson history');
  const records = new Map();
  let previous = null;
  for (const [i, event] of data.events.entries()) {
    const { hash: checksum, ...unsigned } = event ?? {};
    if (checksum !== digest(unsigned) || event.seq !== i + 1 || event.previousHash !== previous ||
        !actions.includes(event.action) || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid lesson event chain');
    text(event.by, 'reviewer', 200); text(event.reason, 'reason');
    lessonPath(ctx, event.file);
    const r = event.record;
    const prior = records.get(event.file);
    if (!r || r.file !== event.file || r.revision !== (prior?.revision ?? 0) + 1 ||
        typeof r.source !== 'string' || hash(r.source) !== r.sourceHash) throw new Error('Invalid lesson revision');
    text(r.rule, 'rule'); text(r.applicability, 'applicability'); scopePath(ctx, r.scope);
    if (!Array.isArray(r.evidence) || r.evidence.length > 50) throw new Error('Invalid lesson evidence');
    for (const e of r.evidence) {
      safe(ctx.root, e.path);
      if (!/^[a-f0-9]{64}$/.test(e.hash)) throw new Error('Invalid lesson evidence hash');
    }
    const status = event.action === 'retire' ? 'retired' : event.action === 'duplicate' ? 'duplicate' : 'active';
    if (r.status !== status || (event.action === 'correct' && !prior)) throw new Error('Invalid lesson transition');
    if (event.action === 'duplicate') {
      const target = records.get(r.duplicateOf);
      if (!target || target.status !== 'active' || target.file === r.file || !overlaps(target.scope, r.scope) || r.targetHash !== digest(target)) {
        throw new Error('Duplicate target must be a different active lesson with overlapping scope');
      }
    } else if (r.duplicateOf !== null || r.targetHash !== null) throw new Error('Unexpected duplicate reference');
    records.set(event.file, r);
    previous = checksum;
  }
  return records;
}

function load(ctx) {
  if (!fs.existsSync(safe(ctx.dir, 'records.json'))) return { schemaVersion: 1, events: [] };
  if (fs.statSync(safe(ctx.dir, 'records.json')).size > MAX) throw new Error('Lesson history exceeds 16 MiB');
  const data = new State(ctx.dir).get('records');
  replay(ctx, data);
  return data;
}

function freshness(ctx, record) {
  const changed = [];
  for (const [i, e] of [{ path: record.file, hash: record.sourceHash }, ...record.evidence].entries()) {
    const file = safe(ctx.root, e.path);
    try {
      if (hash(i === 0 ? readFile(file) : readBytes(file, 8 * 1024 * 1024)) !== e.hash) changed.push(e.path);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      changed.push(e.path);
    }
  }
  return { freshness: changed.length ? 'stale' : record.evidence.length ? 'current' : 'unchecked', changed };
}

export function lessonKnowledge(root, cfg, { file, scope = '.' } = {}) {
  const ctx = context(root, cfg);
  scopePath(ctx, scope);
  if (file !== undefined) lessonPath(ctx, file);
  const data = load(ctx);
  const records = replay(ctx, data);
  // Legacy lessons are discovered without importing or rewriting their Markdown/index.
  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      const abs = safe(ctx.root, rel);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.name.endsWith('.md') && !records.has(rel)) records.set(rel, {
        file: rel, status: 'unreviewed', scope: '.', applicability: 'Not reviewed', revision: 0,
        rule: null, evidence: [], sourceHash: null,
      });
    }
  };
  walk(safe(ctx.root, ctx.lessons), ctx.lessons);
  if (file !== undefined && !records.has(file)) throw new Error('Unknown lesson file');
  const lessons = [...records.values()].filter((r) => (!file || r.file === file) && overlaps(scope, r.scope))
    .sort((a, b) => a.file.localeCompare(b.file)).map((r) => ({ ...r,
      ...(r.revision ? freshness(ctx, r) : { freshness: 'unchecked', changed: [] }) }));
  return { schemaVersion: 1, attribution: 'Caller-supplied names; not authenticated identities', lessons,
    history: data.events.filter((e) => lessons.some((r) => r.file === e.file)) };
}

export function recordLesson(root, cfg, action, options = {}) {
  if (!actions.includes(action)) throw new Error('Unknown lesson action');
  const ctx = context(root, cfg);
  const file = options.file;
  const abs = lessonPath(ctx, file);
  text(options.by, 'reviewer', 200); text(options.reason, 'reason');
  const lock = acquireLock(safe(ctx.dir, 'lessons.lock'), { name: 'brain-lessons' });
  if (!lock) throw new Error('Another command holds the lesson review lock');
  try {
    const data = load(ctx);
    const records = replay(ctx, data);
    const prior = records.get(file);
    if (action === 'correct' && !prior) throw new Error('Review the lesson before correcting it');
    const source = action === 'retire' && prior ? prior.source : readFile(abs);
    const evidencePaths = options.evidence ?? prior?.evidence.map((e) => e.path) ?? [];
    if (!Array.isArray(evidencePaths) || evidencePaths.length > 50) throw new Error('At most 50 lesson evidence paths are allowed');
    const evidence = action === 'retire' && prior ? prior.evidence : [...new Set(evidencePaths)].map((p) => ({
      path: p, hash: hash(readBytes(safe(ctx.root, p), 8 * 1024 * 1024)),
    }));
    const record = { file, revision: (prior?.revision ?? 0) + 1, source, sourceHash: hash(source),
      rule: action === 'correct' ? options.rule : prior?.rule ?? ruleFrom(source),
      scope: options.scope ?? prior?.scope ?? '.', applicability: options.applicability ?? prior?.applicability ?? 'Not reviewed',
      evidence, status: action === 'retire' ? 'retired' : action === 'duplicate' ? 'duplicate' : 'active',
      duplicateOf: action === 'duplicate' ? options['duplicate-of'] : null, targetHash: null };
    if (action === 'review') text(options.applicability, 'applicability');
    if (action === 'duplicate') {
      const target = records.get(record.duplicateOf);
      if (!target || freshness(ctx, target).freshness === 'stale') throw new Error('Duplicate target must be reviewed and not stale');
      record.targetHash = digest(target);
    }
    const last = data.events.at(-1);
    if (last?.file === file && last.action === action && last.by === options.by && last.reason === options.reason &&
        digest({ ...record, revision: last.record.revision }) === digest(last.record)) return { created: false, event: last };
    const unsigned = { seq: data.events.length + 1, action, file, by: options.by, reason: options.reason,
      at: new Date().toISOString(), previousHash: last?.hash ?? null, record };
    const event = { ...unsigned, hash: digest(unsigned) };
    const next = { schemaVersion: 1, events: [...data.events, event] };
    replay(ctx, next);
    if (Buffer.byteLength(JSON.stringify(next, null, 2) + '\n') > MAX) throw new Error('Lesson history would exceed 16 MiB');
    new State(ctx.dir).set('records', next);
    return { created: true, event };
  } finally { lock.release(); }
}

export function lessonDuplicates(root, cfg, options = {}) {
  const ctx = context(root, cfg);
  const lessons = lessonKnowledge(root, cfg, options).lessons.filter((r) => ['active', 'unreviewed'].includes(r.status));
  const candidates = [];
  if (lessons.length > 500) throw new Error('Duplicate review supports up to 500 lessons; narrow --scope');
  const rules = lessons.map((r) => ({ ...r, words: new Set((r.rule ?? ruleFrom(readFile(lessonPath(ctx, r.file))))
    .toLowerCase().match(/[a-z0-9]+/g) ?? []) }));
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) {
    const a = rules[i], b = rules[j];
    const union = new Set([...a.words, ...b.words]).size;
    const score = union ? [...a.words].filter((w) => b.words.has(w)).length / union : 0;
    if (overlaps(a.scope, b.scope) && score >= 0.8) candidates.push({ left: a.file, right: b.file, score,
      reason: 'Rule word overlap >= 80%; human review required, not semantic equivalence' });
  }
  return { candidates };
}

// Only legacy unreviewed or applicable, non-stale active revisions enter ticket prompts.
export function lessonSelection(root, cfg, rows, { paths = [], text: query = '' } = {}) {
  const view = lessonKnowledge(root, cfg);
  const records = new Map(view.lessons.map((r) => [r.file, r]));
  // The configured workspace owns review policy even when code runs in a Git worktree.
  // Verify those records against the actual worktree bytes before selecting guidance.
  if (fs.realpathSync(root) !== fs.realpathSync(cfg.workspace)) {
    const ctx = context(root, cfg);
    for (const r of lessonKnowledge(cfg.workspace, cfg).lessons) if (r.revision) {
      records.set(r.file, { ...r, ...freshness(ctx, r) });
    }
  }
  return rows.flatMap((row) => {
    const r = records.get(row.file);
    if (!r || !['active', 'unreviewed'].includes(r.status) || r.freshness === 'stale') return [];
    if (r.scope !== '.' && !paths.some((p) => overlaps(p.replace(/\\/g, '/').replace(/\/$/, ''), r.scope)) &&
        !query.split(/[\s"'`,;()]+/).some((p) => p && p !== '.' && overlaps(p.replace(/\\/g, '/'), r.scope))) return [];
    return [{ ...row, summary: r.rule ?? row.summary, review: r.status, applicability: r.applicability,
      scope: r.scope, revision: r.revision, freshness: r.freshness }];
  });
}
