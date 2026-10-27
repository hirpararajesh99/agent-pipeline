import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.mjs';
import { lessonKnowledge, lessonDuplicates, recordLesson } from '../src/brain-lessons.mjs';
import { writeLesson, findContext } from '../src/docs.mjs';
import { acquireLock } from '../src/lock.mjs';
import { buildPlanPrompt } from '../src/prompt.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lessons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { ...structuredClone(DEFAULTS), workspace: root };
  const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  put('App/code.cs', 'original'); put('Other/code.cs', 'unrelated');
  const make = (id = 'T1', rule = 'Check widgets related list before saving') => writeLesson(root, cfg, {
    ticket: { id }, feature: 'widgets', lesson: { title: 'Check related list', symptom: 'Missing related widgets', rootCause: 'Missing refresh', rule, keywords: ['widgets'] },
  })[0];
  const file = make();
  const ledger = path.join(root, '.project-brain/lessons/records.json');
  const record = (action, extra = {}) => recordLesson(root, cfg, action, { file, by: 'Rajesh', reason: 'Reviewed behavior', ...extra });
  const view = () => lessonKnowledge(root, cfg, { file }).lessons[0];
  const select = (paths = []) => findContext(root, cfg, { id: 'T1', title: 'Widgets related list saving .', description: '', paths }).lessons;
  return { root, cfg, file, ledger, make, put, record, view, select };
}

test('legacy lessons remain unreviewed without creating lifecycle state', (t) => {
  const s = setup(t);
  assert.equal(s.view().status, 'unreviewed');
  assert.equal(s.select()[0].review, 'unreviewed');
  assert.equal(fs.existsSync(s.ledger), false);
});

test('review records applicability and evidence; scoped selection excludes unrelated tickets', (t) => {
  const s = setup(t);
  s.record('review', { scope: 'App', applicability: 'When saving widget lists', evidence: ['App/code.cs'] });
  assert.equal(s.view().freshness, 'current');
  assert.equal(s.select().length, 0);
  assert.equal(s.select(['Other/code.cs']).length, 0);
  assert.equal(s.select(['App/code.cs'])[0].applicability, 'When saving widget lists');
  s.put('docs/features/widgets/README.md', '---\ntitle: Widgets\nkeywords: [widgets]\npaths: [App]\n---\nWidget list saving');
  assert.equal(s.select().length, 1);
});

test('correction preserves source and historical rules while selecting effective guidance', (t) => {
  const s = setup(t);
  const source = fs.readFileSync(path.join(s.root, s.file), 'utf8');
  s.record('review', { applicability: 'Widget writes' });
  s.record('correct', { rule: 'Refresh widgets only after commit', reason: 'Rollback behavior' });
  const view = lessonKnowledge(s.root, s.cfg, { file: s.file });
  assert.equal(view.history.length, 2);
  assert.match(view.history[0].record.rule, /before saving/);
  assert.equal(s.select()[0].summary, 'Refresh widgets only after commit');
  assert.equal(s.view().freshness, 'unchecked');
  assert.equal(fs.readFileSync(path.join(s.root, s.file), 'utf8'), source);
  const prompt = buildPlanPrompt({ cfg: { ...s.cfg, jobs: { plan: path.join(s.root, 'missing-job') } },
    ticket: { id: 'T1', title: 'Widgets' }, comments: [], context: { features: [], lessons: s.select() }, artifactsDir: s.root });
  assert.match(prompt, /Refresh widgets only after commit/);
  assert.doesNotMatch(prompt, /before saving/);
  assert.match(prompt, /original Markdown is historical/);
});

test('worktrees honor workspace retirement and check active guidance against worktree evidence', (t) => {
  const s = setup(t);
  const work = path.join(s.root, 'worktree');
  fs.mkdirSync(work);
  fs.cpSync(path.join(s.root, 'docs'), path.join(work, 'docs'), { recursive: true });
  fs.cpSync(path.join(s.root, 'App'), path.join(work, 'App'), { recursive: true });
  const selected = () => findContext(work, s.cfg, { id: 'T1', title: 'Widgets', description: '' }).lessons;
  s.record('review', { applicability: 'Widget writes', evidence: ['App/code.cs'] });
  assert.equal(selected()[0].review, 'active');
  s.put('worktree/App/code.cs', 'different branch');
  assert.equal(selected().length, 0);
  s.put('worktree/App/code.cs', 'original');
  s.record('retire');
  assert.equal(selected().length, 0);
});

test('external evidence and lesson edits become stale, unrelated edits do not', (t) => {
  const s = setup(t);
  s.record('review', { applicability: 'Widget writes', evidence: ['App/code.cs'] });
  s.put('Other/code.cs', 'changed');
  assert.equal(s.view().freshness, 'current');
  s.put('App/code.cs', 'changed');
  assert.equal(s.view().freshness, 'stale');
  assert.equal(s.select().length, 0);
  s.record('review', { applicability: 'Widget writes', reason: 'Rechecked evidence' });
  assert.equal(s.view().freshness, 'current');
  fs.appendFileSync(path.join(s.root, s.file), '\nExternal note');
  assert.deepEqual(s.view().changed, [s.file]);
  fs.unlinkSync(path.join(s.root, 'App/code.cs'));
  assert.equal(s.view().changed.length, 2);
});

test('retirement excludes guidance but preserves history and can be explicitly reviewed again', (t) => {
  const s = setup(t);
  s.record('review', { applicability: 'Widget writes' });
  s.record('retire', { reason: 'Module no longer used' });
  assert.equal(s.view().status, 'retired'); assert.equal(s.select().length, 0);
  s.record('review', { applicability: 'Restored module', reason: 'New implementation checked' });
  assert.equal(s.view().status, 'active'); assert.equal(s.select().length, 1);
  fs.unlinkSync(path.join(s.root, s.file));
  s.record('retire', { reason: 'Source removed' });
  assert.equal(s.view().status, 'retired');
  assert.equal(lessonKnowledge(s.root, s.cfg).history.length, 4);
});

test('duplicate suggestions require a human action and retain both lessons', (t) => {
  const s = setup(t);
  const second = s.make('T2');
  assert.equal(lessonDuplicates(s.root, s.cfg).candidates.length, 1);
  assert.equal(s.view().status, 'unreviewed');
  assert.throws(() => s.record('duplicate', { 'duplicate-of': second }), /reviewed/);
  recordLesson(s.root, s.cfg, 'review', { file: second, by: 'Reviewer', reason: 'Compared', applicability: 'Widget writes' });
  s.record('duplicate', { 'duplicate-of': second, reason: 'Same rule and conditions' });
  assert.equal(s.view().status, 'duplicate');
  assert.equal(s.select().some((r) => r.file === s.file), false);
  assert.equal(fs.existsSync(path.join(s.root, s.file)), true);
  assert.equal(lessonDuplicates(s.root, s.cfg).candidates.length, 0);
  assert.throws(() => recordLesson(s.root, s.cfg, 'duplicate', { file: second, by: 'Reviewer', reason: 'Loop', 'duplicate-of': s.file }), /active/);
});

test('invalid transitions, scope and paths cannot replace the ledger', (t) => {
  const s = setup(t);
  assert.throws(() => s.record('correct', { rule: 'New rule' }), /Review/);
  assert.throws(() => s.record('review'), /applicability/);
  s.record('review', { applicability: 'Widget writes' });
  const before = fs.readFileSync(s.ledger, 'utf8');
  for (const bad of [{ scope: '../outside' }, { evidence: ['../secret'] }, { file: 'App/code.cs' }, { by: '' }]) {
    assert.throws(() => s.record('review', { applicability: 'Widget writes', ...bad }));
  }
  assert.equal(fs.readFileSync(s.ledger, 'utf8'), before);
});

test('identical retries are idempotent and failed atomic writes preserve the previous version', (t) => {
  const s = setup(t);
  const options = { applicability: 'Widget writes' };
  s.record('review', options);
  const before = fs.readFileSync(s.ledger, 'utf8');
  assert.equal(s.record('review', options).created, false);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === s.ledger) throw new Error('simulated rename failure'); return rename(from, to); };
  try { assert.throws(() => s.record('retire'), /simulated/); } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(s.ledger, 'utf8'), before);
  assert.equal(s.record('retire').created, true);
});

test('locks and corrupt history fail closed in commands and retrieval', (t) => {
  const s = setup(t);
  s.record('review', { applicability: 'Widget writes' });
  const lock = acquireLock(path.join(path.dirname(s.ledger), 'lessons.lock'));
  try { assert.throws(() => s.record('retire'), /lock/); } finally { lock.release(); }
  const data = JSON.parse(fs.readFileSync(s.ledger, 'utf8'));
  data.events[0].record.rule = 'tampered';
  fs.writeFileSync(s.ledger, JSON.stringify(data));
  assert.throws(() => s.view(), /chain/); assert.throws(() => s.select(), /chain/);
  fs.writeFileSync(s.ledger, '{');
  assert.throws(() => s.view(), /Invalid JSON/);
});

test('symlinked lesson storage and evidence are rejected', (t) => {
  const s = setup(t);
  const target = path.join(s.root, 'Other');
  fs.symlinkSync(target, path.join(s.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => s.record('review', { applicability: 'Widgets', evidence: ['linked/code.cs'] }), /symlink/);
  fs.mkdirSync(path.join(s.root, '.project-brain'), { recursive: true });
  // A prior failed command may create the lock directory; remove only that empty directory.
  fs.rmdirSync(path.join(s.root, '.project-brain/lessons'));
  fs.symlinkSync(target, path.join(s.root, '.project-brain/lessons'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => s.view(), /symlink/);
  assert.equal(fs.existsSync(path.join(target, 'records.json')), false);
});

test('lesson CLI validates options, displays history and redacts text without corrupting JSON', (t) => {
  const s = setup(t);
  const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, 'brain', 'lesson', ...args], { cwd: s.root, encoding: 'utf8' });
  const review = run('review', '--file', s.file, '--by', 'Reviewer', '--reason', 'password=hidden', '--applicability', 'Widget writes');
  assert.equal(review.status, 0, review.stderr);
  assert.match(JSON.parse(review.stdout).event.reason, /redacted/);
  assert.equal(run('correct', '--file', s.file, '--by', 'Reviewer', '--reason', 'Bug fix', '--rule', 'Refresh widgets after commit').status, 0);
  assert.equal(run('retire', '--file', s.file, '--by', 'Reviewer', '--reason', 'Old module').status, 0);
  const shown = run('show', '--file', s.file);
  assert.equal(JSON.parse(shown.stdout).history.length, 3);
  assert.notEqual(run('show').status, 0);
  assert.notEqual(run('list', '--name', 'default').status, 0);
  assert.notEqual(run('review', '--file').status, 0);
});
