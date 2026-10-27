import fs from 'node:fs';
import path from 'node:path';
import { State } from './state.mjs';
import { acquireLock } from './lock.mjs';
import { context, safe, text, jsonHash, readState, verifyRun, locked, acceptedFindings } from './brain.mjs';

const REL = '.project-brain/review';
const MAX_BYTES = 16 * 1024 * 1024;
const TYPES = ['decision.add', 'conflict.add', 'conflict.assign', 'conflict.resolve', 'conflict.reopen'];
const overlaps = (a, b) => a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Review ID must use lowercase letters, digits, hyphens or underscores (max 64)');
}

function person(value) {
  text(value, 'attribution');
  if (value.length > 200) throw new Error('Attribution must be at most 200 characters');
}

function reviewContext(cfg) {
  const root = fs.realpathSync(cfg.workspace);
  const dir = safe(root, REL);
  safe(dir, 'records.json');
  safe(dir, 'review.lock');
  return { root, dir };
}

function scopePath(value = '.') {
  if (typeof value !== 'string' || !value) throw new Error('Review scope must be a project-relative path');
  const scope = value.replace(/\\/g, '/');
  if (scope !== '.' && (scope.includes(':') || scope.includes('\0') || path.posix.isAbsolute(scope) ||
      scope.split('/').some((p) => !p || p === '.' || p === '..'))) throw new Error('Review scope must be a canonical project-relative path');
  return scope;
}

function references(value) {
  if (!Array.isArray(value) || value.length > 50) throw new Error('Review references must be an array of at most 50 records');
  for (const ref of value) {
    if (!ref || !['finding', 'decision'].includes(ref.kind) || typeof ref.hash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.hash)) throw new Error('Invalid review reference');
    if (ref.kind === 'finding' && (!ref.record || jsonHash(ref.record) !== ref.hash)) throw new Error('Invalid pinned finding reference');
    if (ref.kind === 'decision') { identifier(ref.id); text(ref.statement, 'referenced decision'); }
  }
}

// Replay enforces allowed transitions as well as verifying the event hash chain.
// Attribution is supplied by the caller; the ledger is not an identity provider.
function replay(events) {
  const decisions = new Map();
  const conflicts = new Map();
  let previousHash = null;
  for (const [index, event] of events.entries()) {
    if (!event || event.seq !== index + 1 || !TYPES.includes(event.type) || event.previousHash !== previousHash ||
        typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid review event sequence');
    const { hash, ...unsigned } = event;
    if (hash !== jsonHash(unsigned)) throw new Error('Review history hash mismatch');
    identifier(event.id); person(event.by);
    const d = event.data;
    if (!d || typeof d !== 'object') throw new Error('Invalid review event data');
    if (event.type === 'decision.add' || event.type === 'conflict.add') {
      // Scopes are stored as canonical paths; old scopes may no longer exist.
      if (scopePath(d.scope) !== d.scope) throw new Error('Invalid stored review scope');
      references(d.references);
      if (event.type === 'decision.add') {
        text(d.statement, 'decision'); text(d.reason, 'decision rationale');
        if (decisions.has(event.id)) throw new Error('Decision ID already exists; record a new ID with --supersedes');
        if (d.supersedes !== null) {
          identifier(d.supersedes);
          const prior = decisions.get(d.supersedes);
          if (!prior || prior.status !== 'active' || prior.scope !== d.scope) throw new Error('Superseded decision must be active and have the same scope');
          prior.status = 'superseded'; prior.supersededBy = event.id;
        }
        decisions.set(event.id, { id: event.id, ...d, by: event.by, at: event.at, hash,
          source: 'developer', status: 'active', supersededBy: null });
      } else {
        text(d.summary, 'conflict summary'); text(d.left, 'first position'); text(d.right, 'second position'); person(d.owner);
        if (d.left.trim() === d.right.trim()) throw new Error('A conflict needs two distinct positions');
        if (conflicts.has(event.id)) throw new Error('Conflict ID already exists');
        conflicts.set(event.id, { id: event.id, ...d, by: event.by, at: event.at, hash,
          status: 'open', resolution: null, history: [event] });
      }
    } else {
      const conflict = conflicts.get(event.id);
      if (!conflict) throw new Error('Unknown conflict ID');
      text(d.reason, 'conflict action reason');
      if (event.type === 'conflict.reopen') {
        if (conflict.status !== 'resolved') throw new Error('Only a resolved conflict can be reopened');
        conflict.status = 'open'; conflict.resolution = null;
      } else {
        if (conflict.status !== 'open') throw new Error('Conflict is already resolved; reopen it before changing it');
        if (event.by !== conflict.owner) throw new Error('Conflict action must be attributed to its current owner');
        if (event.type === 'conflict.assign') { person(d.owner); conflict.owner = d.owner; }
        else {
          text(d.resolution, 'conflict resolution');
          if (d.decision !== null) {
            const decision = decisions.get(d.decision.id);
            if (!decision || decision.status !== 'active' || decision.hash !== d.decision.hash || !overlaps(decision.scope, conflict.scope)) {
              throw new Error('Resolution decision must be active and apply to the conflict scope');
            }
          }
          conflict.status = 'resolved';
          conflict.resolution = { ...d, by: event.by, at: event.at, hash };
        }
      }
      conflict.hash = hash;
      conflict.history.push(event);
    }
    previousHash = hash;
  }
  return { decisions: [...decisions.values()], conflicts: [...conflicts.values()] };
}

function load(ctx) {
  if (!fs.existsSync(ctx.dir) || !fs.existsSync(safe(ctx.dir, 'records.json'))) return { schemaVersion: 1, events: [] };
  if (fs.statSync(safe(ctx.dir, 'records.json')).size > MAX_BYTES) throw new Error('Review history exceeds 16 MiB');
  const data = new State(ctx.dir).get('records');
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.events)) throw new Error('Invalid review history');
  replay(data.events);
  return data;
}

export function withReviewLock(cfg, fn) {
  const ctx = reviewContext(cfg);
  const lock = acquireLock(path.join(ctx.dir, 'review.lock'), { name: 'brain-review' });
  if (!lock) throw new Error('Another command holds the project review lock');
  try { return fn(ctx); } finally { lock.release(); }
}

export function reviewSnapshot(cfg, scopes = ['.']) {
  const ctx = reviewContext(cfg);
  const selected = [...new Set(scopes.map((s) => scopePath(s)))].sort();
  const view = replay(load(ctx).events);
  return { schemaVersion: 1, scopes: selected,
    decisions: view.decisions.filter((d) => d.status === 'active' && selected.some((s) => overlaps(s, d.scope))),
    conflicts: view.conflicts.filter((c) => c.status === 'open' && selected.some((s) => overlaps(s, c.scope))) };
}

export function runReviewSnapshot(cfg, name = 'default') {
  const ctx = context(cfg, name);
  return locked(ctx, () => {
    const state = readState(ctx); verifyRun(ctx, state);
    const scopes = state.refresh?.reviewScopes ?? [state.scope,
      ...acceptedFindings(ctx, state).flatMap((f) => f.evidence.map((e) => e.path))];
    return reviewSnapshot(cfg, scopes);
  });
}

export function brainReview(cfg, { scope = '.' } = {}) {
  const ctx = reviewContext(cfg);
  scope = scopePath(scope);
  const data = load(ctx);
  const view = replay(data.events);
  const decisions = view.decisions.filter((d) => overlaps(scope, d.scope));
  const conflicts = view.conflicts.filter((c) => overlaps(scope, c.scope));
  return { schemaVersion: 1, scope, attribution: 'Caller-supplied names; not authenticated identities',
    decisions, conflicts, openConflicts: conflicts.filter((c) => c.status === 'open').map((c) => c.id),
    history: data.events.filter((e) => e.type.startsWith('decision.') ? decisions.some((d) => d.id === e.id) : conflicts.some((c) => c.id === e.id)) };
}

function resolveReferences(cfg, ids) {
  if (!Array.isArray(ids) || ids.length > 50) throw new Error('--findings must be a list of at most 50 RUN:ID references');
  return ids.map((id) => {
    if (typeof id !== 'string') throw new Error('Invalid finding reference');
    const match = /^([a-z0-9][a-z0-9_-]{0,47}):(0[1-8]-[a-zA-Z0-9_-]{1,64})$/.exec(id);
    if (!match) throw new Error('Finding references must be RUN:ID');
    const ctx = context(cfg, match[1]);
    return locked(ctx, () => {
      const state = readState(ctx); verifyRun(ctx, state);
      if (state.pending) throw new Error('Finish the interrupted analysis before referencing it');
      const record = acceptedFindings(ctx, state).find((f) => f.id === match[2]);
      if (!record) throw new Error('Finding reference does not identify accepted knowledge');
      return { kind: 'finding', run: ctx.name, hash: jsonHash(record), record };
    });
  });
}

function decisionReference(view, id) {
  identifier(id);
  const record = view.decisions.find((d) => d.id === id);
  if (!record) throw new Error('Unknown decision reference');
  return { kind: 'decision', id: record.id, hash: record.hash, statement: record.statement, scope: record.scope };
}

export function recordReview(cfg, type, options = {}) {
  if (!TYPES.includes(type)) throw new Error('Unknown review action');
  identifier(options.id); person(options.by);
  return withReviewLock(cfg, (ctx) => {
    const ledger = load(ctx);
    const view = replay(ledger.events);
    let data;
    if (type.endsWith('.add')) {
      const refs = resolveReferences(cfg, options.findings ?? []);
      if (!Array.isArray(options.decisions ?? []) || (options.decisions ?? []).length + refs.length > 50) throw new Error('At most 50 review references are allowed');
      for (const id of options.decisions ?? []) refs.push(decisionReference(view, id));
      const common = { scope: scopePath(options.scope ?? '.'), references: refs };
      data = type === 'decision.add'
        ? { ...common, statement: options.statement, reason: options.reason, supersedes: options.supersedes ?? null }
        : { ...common, summary: options.summary, left: options.left, right: options.right, owner: options.owner ?? options.by };
    } else if (type === 'conflict.resolve') {
      data = { reason: options.reason, resolution: options.resolution,
        decision: options.decision === undefined ? null : decisionReference(view, options.decision) };
    } else data = type === 'conflict.assign' ? { reason: options.reason, owner: options.owner } : { reason: options.reason };
    // Retrying the same creation or the latest identical transition is a no-op.
    const existing = type.endsWith('.add') ? ledger.events.find((e) => e.type === type && e.id === options.id) : ledger.events.at(-1);
    if (existing?.type === type && existing.id === options.id && existing.by === options.by && jsonHash(existing.data) === jsonHash(data)) {
      return { created: false, event: existing };
    }
    const unsigned = { seq: ledger.events.length + 1, type, id: options.id, by: options.by,
      at: new Date().toISOString(), data, previousHash: ledger.events.at(-1)?.hash ?? null };
    const event = { ...unsigned, hash: jsonHash(unsigned) };
    const next = { schemaVersion: 1, events: [...ledger.events, event] };
    replay(next.events);
    if (Buffer.byteLength(JSON.stringify(next, null, 2) + '\n') > MAX_BYTES) throw new Error('Review history would exceed 16 MiB; archive/export planning is required');
    new State(ctx.dir).set('records', next);
    return { created: true, event };
  });
}
