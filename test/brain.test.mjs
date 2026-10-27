import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.mjs';
import { initBrain, analyzeBrain, brainStatus, brainFreshness, runBrain, BRAIN_STAGES } from '../src/brain.mjs';
import { refreshBrain } from '../src/brain-refresh.mjs';
import { brainReview, recordReview, reviewSnapshot, runReviewSnapshot } from '../src/brain-review.mjs';
import { atomicWrite, readJson, writeJson } from '../src/util.mjs';
import { acquireLock } from '../src/lock.mjs';

function setup(t, modern = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { ...structuredClone(DEFAULTS), workspace: root };
  const put = (rel, content) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  put('App/App.csproj', '<Project><ProjectReference Include="../Core/Core.csproj" /></Project>');
  put('Core/Core.csproj', '<Project />');
  put('App.sln', 'Project("id") = "App", "App\\App.csproj", "id"');
  if (modern) put('App/Program.cs', 'namespace Demo;\nclass Startup {}\napp.MapGet("/health", () => "ok");\n');
  else {
    put('App/Default.aspx', '<%@ Page CodeBehind="Default.aspx.cs" %>');
    put('App/Default.aspx.cs', 'namespace Demo;\nclass Home {}\n');
  }
  const file = modern ? 'App/Program.cs' : 'App/Default.aspx.cs';
  const run = '.project-brain/runs/default';
  const state = () => readJson(path.join(root, run, 'state.json'));
  const submission = (id, change = () => {}) => {
    const s = state();
    const v = { schemaVersion: 1, stage: id, snapshotId: s.snapshotId, scope: s.scope,
      summary: `Stage ${id} summary`, findings: [{ id: `${id}-entry`, statement: 'Source declares the Demo namespace',
        certainty: 'verified', verification: 'Read the declaration on line 1',
        evidence: [{ path: file, hash: s.files[file], startLine: 1, endLine: 1 }] }],
      unknowns: ['Business rationale is undocumented'], limitations: ['No runtime verification'] };
    change(v);
    writeJson(path.join(root, run, `submissions/${id}.json`), v);
    return v;
  };
  return { root, cfg, put, file, run, state, submission };
}

for (const modern of [false, true]) test(`brain bootstraps ${modern ? 'modern' : 'legacy'} .NET and completes eight evidence-linked stages`, (t) => {
  const s = setup(t, modern);
  const initial = initBrain(s.cfg, { scope: 'App' });
  assert.equal(initial.nextStage, '01');
  const knowledge = readJson(path.join(s.root, s.run, 'knowledge/project.json'));
  assert.ok(knowledge.selectedFiles.every((f) => f.startsWith('App/')));
  assert.ok(knowledge.graph.edges.some((e) => e.kind === (modern ? 'defines-route' : 'code-behind')));
  assert.equal(knowledge.revision, null);
  assert.ok(knowledge.limitations.some((s) => s.includes('No documentation')));
  for (const stage of BRAIN_STAGES) {
    const prompt = fs.readFileSync(path.join(s.root, s.run, `prompts/${stage[0]}-${stage[1]}.md`), 'utf8');
    assert.ok(prompt.includes('Do not invent'));
    s.submission(stage[0]);
    const result = analyzeBrain(s.cfg);
    assert.equal(result.completed.length, Number(stage[0]));
  }
  const status = brainStatus(s.cfg);
  assert.equal(status.status, 'complete');
  const summary = fs.readFileSync(path.join(s.root, status.synthesis), 'utf8');
  assert.match(summary, /01-repository-overview\.md/);
  assert.match(summary, /Business rationale is undocumented/);
  const detail = fs.readFileSync(path.join(s.root, s.run, 'ai-analysis/01-repository-overview.md'), 'utf8');
  assert.match(detail, /SHA-256/);
  assert.match(detail, /lines 1-1/);
  assert.equal(analyzeBrain(s.cfg).status, 'complete');
});

test('brain init preserves existing docs, prompts and progress on repeated initialization', (t) => {
  const s = setup(t);
  s.put('.ai/project-context.md', 'Developer-maintained context');
  s.put('docs/architecture.md', 'Existing design');
  initBrain(s.cfg);
  s.submission('01'); analyzeBrain(s.cfg);
  const before = fs.readFileSync(path.join(s.root, s.run, 'state.json'), 'utf8');
  assert.equal(initBrain(s.cfg).nextStage, '02');
  assert.equal(fs.readFileSync(path.join(s.root, s.run, 'state.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(s.root, '.ai/project-context.md'), 'utf8'), 'Developer-maintained context');
  assert.throws(() => initBrain(s.cfg, { scope: 'App' }), /different scope/);
  s.put('.project-brain/runs/custom/notes.md', 'Keep me');
  assert.throws(() => initBrain(s.cfg, { name: 'custom' }), /nothing overwritten/);
});

test('missing, partial, invalid and out-of-order submissions never advance a stage', (t) => {
  const s = setup(t); initBrain(s.cfg);
  s.submission('02');
  assert.equal(analyzeBrain(s.cfg).nextStage, '01');
  s.put(`${s.run}/submissions/01.json`, '{');
  assert.throws(() => analyzeBrain(s.cfg), /Invalid JSON/);
  assert.deepEqual(brainStatus(s.cfg).completed, []);
  s.submission('01', (v) => { v.snapshotId = 'wrong'; });
  assert.throws(() => analyzeBrain(s.cfg), /snapshotId/);
  s.submission('01');
  assert.equal(analyzeBrain(s.cfg).nextStage, '02');
  assert.equal(analyzeBrain(s.cfg).nextStage, '03');
});

test('evidence rejects traversal, missing paths, bad hashes, bad ranges and unsupported certainty', (t) => {
  const s = setup(t); initBrain(s.cfg);
  const bad = [
    (v) => { v.findings[0].evidence[0].path = '../outside.cs'; },
    (v) => { v.findings[0].evidence[0].path = 'absent.cs'; },
    (v) => { v.findings[0].evidence[0].hash = 'bad'; },
    (v) => { v.findings[0].evidence[0].endLine = 9000; },
    (v) => { v.findings[0].certainty = 'certain'; },
    (v) => { v.findings[0].evidence = []; },
    (v) => { v.findings[0].verification = ''; },
    (v) => { v.findings.push(v.findings[0]); },
  ];
  for (const change of bad) {
    s.submission('01', change);
    assert.throws(() => analyzeBrain(s.cfg));
    assert.deepEqual(s.state().accepted, []);
  }
  s.submission('01', (v) => { v.findings = []; });
  assert.equal(analyzeBrain(s.cfg).nextStage, '02');
});

for (const action of ['modify', 'add', 'delete']) test(`snapshot guard detects ${action} outside module scope and never reverts user files`, (t) => {
  const s = setup(t); initBrain(s.cfg, { scope: 'App' }); s.submission('01');
  if (action === 'delete') fs.unlinkSync(path.join(s.root, 'Core/Core.csproj'));
  else s.put(action === 'add' ? 'bin/worker.js' : 'Core/Core.csproj', 'User edit');
  assert.throws(() => analyzeBrain(s.cfg), /Application snapshot changed/);
  assert.throws(() => brainStatus(s.cfg), /Application snapshot changed/);
  assert.equal(s.state().accepted.length, 0);
  assert.equal(initBrain(s.cfg, { name: 'new-run', scope: 'App' }).nextStage, '01');
  if (action !== 'delete') assert.equal(fs.readFileSync(path.join(s.root, action === 'add' ? 'bin/worker.js' : 'Core/Core.csproj'), 'utf8'), 'User edit');
});

test('generated controls and accepted submissions cannot be silently changed', (t) => {
  const s = setup(t); initBrain(s.cfg); s.submission('01'); analyzeBrain(s.cfg);
  const promptPath = `${s.run}/prompts/02-architecture.md`;
  const before = fs.readFileSync(path.join(s.root, promptPath), 'utf8');
  s.put(promptPath, 'Changed');
  assert.throws(() => brainStatus(s.cfg), /generated file changed/);
  s.put(promptPath, before);
  s.submission('01', (v) => { v.summary = 'Changed'; });
  assert.throws(() => analyzeBrain(s.cfg), /Accepted submission 01 changed/);
});

test('unexpected files inside analysis output are rejected', (t) => {
  const s = setup(t); initBrain(s.cfg);
  s.put(`${s.run}/submissions/application.cs`, 'Unexpected');
  assert.throws(() => analyzeBrain(s.cfg), /Unexpected analysis output/);
});

test('interrupted rendering resumes the journal without skipping or double-accepting a stage', (t) => {
  const s = setup(t); initBrain(s.cfg); s.submission('01');
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('01-repository-overview.md')) throw new Error('Simulated interruption');
    return original(from, to);
  };
  try { assert.throws(() => analyzeBrain(s.cfg), /Simulated interruption/); }
  finally { fs.renameSync = original; }
  // atomicWrite leaves its temporary file on a failed rename. The recovery must
  // account for that file rather than accepting it as arbitrary agent output.
  assert.ok(s.state().pending);
  const originalSource = fs.readFileSync(path.join(s.root, s.file), 'utf8');
  s.put(s.file, 'Changed while analysis was interrupted');
  assert.throws(() => analyzeBrain(s.cfg), /Application snapshot changed/);
  assert.equal(s.state().accepted.length, 0);
  s.put(s.file, originalSource);
  const result = analyzeBrain(s.cfg);
  assert.deepEqual(result.completed, ['01']);
  assert.equal(analyzeBrain(s.cfg).nextStage, '02');
});

test('unsafe run names/scopes and concurrent commands are refused', (t) => {
  const s = setup(t);
  assert.throws(() => initBrain(s.cfg, { name: '../escape' }), /run name/);
  assert.throws(() => initBrain(s.cfg, { scope: '../escape' }), /canonical/);
  initBrain(s.cfg);
  const lock = acquireLock(path.join(s.root, s.run, 'run.lock'));
  try { assert.throws(() => analyzeBrain(s.cfg), /holds this run lock/); }
  finally { lock.release(); }
});

test('symlink output locations are rejected', (t) => {
  const s = setup(t);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-link-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  try { fs.symlinkSync(target, path.join(s.root, '.project-brain'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit symlink creation'); return; } throw error; }
  assert.throws(() => initBrain(s.cfg), /symlink/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('CLI supports standalone bootstrap and reports failures with a nonzero exit', (t) => {
  const s = setup(t);
  const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));
  const call = (...args) => spawnSync(process.execPath, [cli, 'brain', ...args], { cwd: s.root, encoding: 'utf8' });
  const init = call('init', '--scope', 'App');
  assert.equal(init.status, 0, init.stderr || String(init.error));
  assert.equal(JSON.parse(init.stdout).nextStage, '01');
  assert.equal(call('status').status, 0);
  assert.equal(call('analyze').status, 0);
  s.put('Core/Core.csproj', 'Changed');
  const failed = call('analyze');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Application snapshot changed/);
});

test('brain run invokes the configured agent for every remaining validated stage', async (t) => {
  const s = setup(t, true);
  s.cfg.stateDir = path.join(s.root, '.pipeline-state');
  s.cfg.agent = { ...s.cfg.agent, provider: 'fake', maxMinutes: 1, providers: {
    fake: { command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs')], promptMode: 'stdin' },
  } };
  initBrain(s.cfg);
  const result = await runBrain(s.cfg);
  assert.equal(result.status, 'complete');
  assert.equal(result.completed.length, 8);
  assert.match(fs.readFileSync(path.join(s.root, result.synthesis), 'utf8'), /Automated stage 08 summary/);
});

test('freshness checks accepted evidence independently of certainty and preserves the entire run', (t) => {
  const s = setup(t); initBrain(s.cfg, { scope: 'App' });
  s.submission('01', (v) => {
    const original = v.findings[0];
    v.findings = ['verified', 'inferred', 'unknown'].map((certainty) => ({
      ...original, id: `01-${certainty}`, certainty,
    }));
    v.findings.push({ ...original, id: '01-no-evidence', certainty: 'unknown', evidence: [] });
    v.findings.push({ ...original, id: '01-core', evidence: [{
      path: 'Core/Core.csproj', hash: s.state().files['Core/Core.csproj'], startLine: 1, endLine: 1,
    }] });
  });
  analyzeBrain(s.cfg);
  s.submission('02'); // Unaccepted submissions must not be included.
  const runFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? runFiles(file) : [[file, fs.readFileSync(file).toString('base64')]];
  });
  const before = runFiles(path.join(s.root, s.run));
  const source = fs.readFileSync(path.join(s.root, s.file), 'utf8');
  const fresh = brainFreshness(s.cfg);
  assert.equal(fresh.snapshotChanged, false);
  assert.equal(fresh.currentSnapshotId, fresh.snapshotId);
  assert.deepEqual(fresh.counts, { current: 4, stale: 0, unchecked: 1 });
  s.put(s.file, `${source}// Changed by a developer outside the pipeline\n`);
  const changed = brainFreshness(s.cfg);
  assert.equal(changed.analysisStatus, 'awaiting-analysis');
  assert.deepEqual(changed.completed, ['01']);
  assert.deepEqual(changed.counts, { current: 1, stale: 3, unchecked: 1 });
  assert.deepEqual(changed.changes, [{ path: s.file, change: 'modified' }]);
  assert.notEqual(changed.currentSnapshotId, changed.snapshotId);
  for (const certainty of ['verified', 'inferred', 'unknown']) {
    const finding = changed.findings.find((f) => f.id === `01-${certainty}`);
    assert.equal(finding.certainty, certainty);
    assert.equal(finding.freshness, 'stale');
    assert.equal(finding.evidence[0].status, 'modified');
    assert.notEqual(finding.evidence[0].currentHash, finding.evidence[0].expectedHash);
  }
  assert.deepEqual(runFiles(path.join(s.root, s.run)), before);
  assert.throws(() => analyzeBrain(s.cfg), /Application snapshot changed/);
  assert.throws(() => brainStatus(s.cfg), /Application snapshot changed/);
  // Freshness reflects current bytes, and never permanently relabels old evidence.
  s.put(s.file, source);
  assert.deepEqual(brainFreshness(s.cfg).counts, fresh.counts);
  assert.deepEqual(runFiles(path.join(s.root, s.run)), before);
});

test('freshness reports deleted evidence and unrelated additions without marking every finding stale', (t) => {
  const s = setup(t); initBrain(s.cfg); s.submission('01'); analyzeBrain(s.cfg);
  s.put('Core/new.cs', 'class New {}');
  s.put('Core/Core.csproj', '<Project>Changed</Project>');
  const added = brainFreshness(s.cfg);
  assert.equal(added.snapshotChanged, true);
  assert.deepEqual(added.counts, { current: 1, stale: 0, unchecked: 0 });
  assert.deepEqual(added.changes, [
    { path: 'Core/Core.csproj', change: 'modified' }, { path: 'Core/new.cs', change: 'added' },
  ]);
  fs.unlinkSync(path.join(s.root, s.file));
  const deleted = brainFreshness(s.cfg);
  assert.deepEqual(deleted.counts, { current: 0, stale: 1, unchecked: 0 });
  assert.equal(deleted.findings[0].evidence[0].status, 'deleted');
  assert.equal(deleted.findings[0].evidence[0].currentHash, null);
});

test('freshness of an empty or completed run reports only accepted findings', (t) => {
  const s = setup(t); initBrain(s.cfg); s.submission('01');
  assert.deepEqual(brainFreshness(s.cfg).counts, { current: 0, stale: 0, unchecked: 0 });
  for (const [id] of BRAIN_STAGES) { s.submission(id); analyzeBrain(s.cfg); }
  s.put(s.file, 'Changed');
  const result = brainFreshness(s.cfg);
  assert.equal(result.analysisStatus, 'complete');
  assert.deepEqual(result.counts, { current: 0, stale: 8, unchecked: 0 });
});

test('freshness keeps integrity and lock checks even when application source has changed', (t) => {
  const s = setup(t); initBrain(s.cfg); s.submission('01'); analyzeBrain(s.cfg);
  s.put(s.file, 'Changed');
  const prompt = `${s.run}/prompts/02-architecture.md`;
  const before = fs.readFileSync(path.join(s.root, prompt), 'utf8');
  s.put(prompt, 'Changed control');
  assert.throws(() => brainFreshness(s.cfg), /generated file changed/);
  s.put(prompt, before);
  const lock = acquireLock(path.join(s.root, s.run, 'run.lock'));
  try { assert.throws(() => brainFreshness(s.cfg), /holds this run lock/); }
  finally { lock.release(); }
  s.submission('01', (v) => { v.findings[0].evidence[0].path = '../escape'; });
  assert.throws(() => brainFreshness(s.cfg), /Accepted submission 01 changed/);
});

test('freshness never follows an evidence directory replaced by a symlink', (t) => {
  const s = setup(t); initBrain(s.cfg); s.submission('01'); analyzeBrain(s.cfg);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-evidence-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.writeFileSync(path.join(target, path.basename(s.file)), 'Outside evidence');
  fs.renameSync(path.join(s.root, 'App'), path.join(s.root, 'OldApp'));
  try { fs.symlinkSync(target, path.join(s.root, 'App'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit symlink creation'); return; } throw error; }
  const result = brainFreshness(s.cfg);
  assert.equal(result.findings[0].freshness, 'stale');
  assert.equal(result.findings[0].evidence[0].currentHash, null);
  assert.equal(fs.readFileSync(path.join(target, path.basename(s.file)), 'utf8'), 'Outside evidence');
});

test('CLI freshness works standalone after source changes and rejects invalid options', (t) => {
  const s = setup(t); initBrain(s.cfg); s.submission('01'); analyzeBrain(s.cfg);
  s.put(s.file, 'Changed');
  const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));
  const call = (...args) => spawnSync(process.execPath, [cli, 'brain', 'freshness', ...args], { cwd: s.root, encoding: 'utf8' });
  const result = call('--name', 'default');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).counts.stale, 1);
  assert.equal(call('--scope', 'App').status, 1);
  assert.equal(call('--name', '../escape').status, 1);
  assert.equal(call('--name', 'missing').status, 1);
});

function refreshFixture(t) {
  const s = setup(t); initBrain(s.cfg);
  s.submission('01', (v) => {
    v.findings.push({ ...v.findings[0], id: '01-core', evidence: [{
      path: 'Core/Core.csproj', hash: s.state().files['Core/Core.csproj'], startLine: 1, endLine: 1,
    }] });
    v.findings.push({ ...v.findings[0], id: '01-unknown', certainty: 'unknown', evidence: [] });
  });
  analyzeBrain(s.cfg);
  const load = (name, file) => readJson(path.join(s.root, '.project-brain/runs', name, file));
  const submit = (name, mutate = () => {}) => {
    const state = load(name, 'state.json');
    const base = load(name, 'knowledge/base.json');
    const value = { schemaVersion: 1, kind: 'refresh', snapshotId: state.snapshotId, baseHash: base.baseHash,
      summary: 'Reviewed changed evidence', unknowns: [], limitations: ['No runtime verification'],
      revisions: base.targets.map((target) => {
        const f = base.findings.find((f) => f.id === target.id);
        return { id: f.id, previousHash: target.previousHash, action: 'revise', reason: 'Source changed',
          finding: { id: f.id, statement: 'Revised finding', certainty: f.certainty, verification: 'Inspected new source',
            evidence: f.evidence.map((e) => ({ ...e, hash: state.files[e.path] })) } };
      }) };
    mutate(value);
    writeJson(path.join(s.root, '.project-brain/runs', name, 'submissions/refresh.json'), value);
    return value;
  };
  return { ...s, load, submit };
}

function runBytes(root, name) {
  const dir = path.join(root, '.project-brain/runs', name);
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    return e.isDirectory() ? walk(file) : [[file, fs.readFileSync(file).toString('base64')]];
  });
  return walk(dir);
}

test('refresh revises only stale findings, preserves history, and requires explicit acceptance', async (t) => {
  const s = refreshFixture(t);
  const original = runBytes(s.root, 'default');
  s.put(s.file, 'namespace Revised;\nclass Home {}\n');
  const prepared = refreshBrain(s.cfg, { to: 'review-2' });
  assert.equal(prepared.status, 'awaiting-review');
  assert.deepEqual(prepared.selectedFindings, ['01-entry']);
  assert.equal(brainStatus(s.cfg, { name: 'review-2' }).status, 'awaiting-review');
  assert.equal(brainFreshness(s.cfg, { name: 'review-2' }).counts.stale, 1);
  const base = s.load('review-2', 'knowledge/base.json');
  const preparedBytes = runBytes(s.root, 'review-2');
  refreshBrain(s.cfg, { to: 'review-2' });
  assert.deepEqual(runBytes(s.root, 'review-2'), preparedBytes);
  s.submit('review-2');
  assert.throws(() => analyzeBrain(s.cfg, { name: 'review-2' }), /refresh.*--accept/);
  await assert.rejects(() => runBrain(s.cfg, { name: 'review-2' }), /explicit.*--accept/);
  assert.equal(s.load('review-2', 'state.json').refresh.accepted, undefined);
  const accepted = refreshBrain(s.cfg, { name: 'review-2', accept: true });
  assert.equal(accepted.status, 'complete');
  const records = s.load('review-2', 'knowledge/findings.json').findings;
  assert.equal(records[0].revision.run, 'review-2');
  assert.deepEqual(records[0].previous.revision, base.findings[0].revision);
  assert.equal(records[0].previous.hash, base.targets[0].previousHash);
  assert.deepEqual(records.slice(1), base.findings.slice(1));
  assert.deepEqual(runBytes(s.root, 'default'), original);
  assert.deepEqual(brainFreshness(s.cfg, { name: 'review-2' }).counts, { current: 2, stale: 0, unchecked: 1 });
  assert.equal(brainFreshness(s.cfg).counts.stale, 1);
  const complete = runBytes(s.root, 'review-2');
  refreshBrain(s.cfg, { name: 'review-2', accept: true });
  assert.deepEqual(runBytes(s.root, 'review-2'), complete);
  assert.match(fs.readFileSync(path.join(s.root, accepted.synthesis), 'utf8'), /Revised finding/);
});

test('successive refreshes inherit the latest accepted revisions and keep earlier runs intact', (t) => {
  const s = refreshFixture(t); s.put(s.file, 'First change\n');
  refreshBrain(s.cfg, { to: 'v2' }); s.submit('v2'); refreshBrain(s.cfg, { name: 'v2', accept: true });
  const previous = runBytes(s.root, 'v2');
  const records = s.load('v2', 'knowledge/findings.json').findings;
  s.put('Core/Core.csproj', '<Project>New reference</Project>');
  const prepared = refreshBrain(s.cfg, { name: 'v2', to: 'v3' });
  assert.deepEqual(prepared.selectedFindings, ['01-core']);
  s.submit('v3'); refreshBrain(s.cfg, { name: 'v3', accept: true });
  const next = s.load('v3', 'knowledge/findings.json').findings;
  assert.deepEqual(next[0], records[0]);
  assert.equal(next[1].revision.run, 'v3');
  assert.deepEqual(s.load('v3', 'knowledge/base.json').findings, records);
  assert.deepEqual(runBytes(s.root, 'v2'), previous);
});

test('deleted evidence can be retired with a reason while its previous statement is preserved', (t) => {
  const s = refreshFixture(t); fs.unlinkSync(path.join(s.root, s.file));
  refreshBrain(s.cfg, { to: 'retired' });
  s.submit('retired', (v) => {
    v.revisions[0].action = 'retire'; v.revisions[0].reason = 'Entry point was removed'; delete v.revisions[0].finding;
  });
  refreshBrain(s.cfg, { name: 'retired', accept: true });
  const result = brainFreshness(s.cfg, { name: 'retired' });
  assert.deepEqual(result.counts, { current: 1, stale: 0, unchecked: 1 });
  assert.equal(result.retired[0].id, '01-entry');
  assert.equal(result.retired[0].reason, 'Entry point was removed');
  const history = s.load('retired', 'knowledge/base.json').findings[0];
  const retired = s.load('retired', 'knowledge/findings.json').findings[0];
  assert.equal(retired.statement, history.statement);
  assert.deepEqual(retired.evidence, history.evidence);
  assert.throws(() => refreshBrain(s.cfg, { name: 'retired', to: 'v3', findings: ['01-entry'] }), /active accepted/);
});

test('explicit selection handles uncited changes and unchecked findings without selecting everything', (t) => {
  const s = refreshFixture(t);
  assert.throws(() => refreshBrain(s.cfg, { to: 'none' }), /No stale findings/);
  s.put('Core/New.cs', 'namespace Demo;');
  refreshBrain(s.cfg, { to: 'selected', findings: ['01-unknown'] });
  s.submit('selected', (v) => {
    v.revisions[0].finding.certainty = 'inferred';
    v.revisions[0].finding.evidence = [{ path: 'Core/New.cs', hash: s.load('selected', 'state.json').files['Core/New.cs'], startLine: 1, endLine: 1 }];
  });
  refreshBrain(s.cfg, { name: 'selected', accept: true });
  assert.deepEqual(brainFreshness(s.cfg, { name: 'selected' }).counts, { current: 3, stale: 0, unchecked: 0 });
  assert.throws(() => refreshBrain(s.cfg, { to: 'selected', findings: ['01-core'] }), /different refresh inputs/);
  assert.throws(() => refreshBrain(s.cfg, { to: '../escape' }), /run name/);
  assert.throws(() => refreshBrain(s.cfg, { to: 'default' }), /new run/);
});

test('invalid refresh operations and evidence never change accepted knowledge', (t) => {
  const s = refreshFixture(t); s.put(s.file, 'Changed\n'); refreshBrain(s.cfg, { to: 'review' });
  const before = s.load('review', 'state.json');
  const bad = [
    (v) => { v.snapshotId = 'wrong'; }, (v) => { v.baseHash = 'wrong'; },
    (v) => { v.revisions = []; }, (v) => { v.revisions.push(v.revisions[0]); },
    (v) => { v.revisions[0].id = '01-core'; }, (v) => { v.revisions[0].previousHash = 'wrong'; },
    (v) => { v.revisions[0].finding.id = '01-new'; }, (v) => { v.revisions[0].reason = ''; },
    (v) => { v.revisions[0].action = 'delete'; }, (v) => { v.revisions[0].finding.certainty = 'certain'; },
    (v) => { v.revisions[0].finding.evidence = []; },
    (v) => { v.revisions[0].finding.evidence[0].path = '../escape'; },
    (v) => { v.revisions[0].finding.evidence[0].hash = 'bad'; },
    (v) => { v.revisions[0].finding.evidence[0].endLine = 9999; },
    (v) => { v.revisions[0].action = 'retire'; },
  ];
  for (const mutate of bad) {
    s.submit('review', mutate);
    assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }));
    assert.deepEqual(s.load('review', 'state.json'), before);
    assert.equal(fs.existsSync(path.join(s.root, '.project-brain/runs/review/knowledge/findings.json')), false);
  }
  s.submit('review', (v) => { v.revisions[0].finding.certainty = 'unknown'; v.revisions[0].finding.evidence = []; });
  refreshBrain(s.cfg, { name: 'review', accept: true });
  assert.deepEqual(brainFreshness(s.cfg, { name: 'review' }).counts, { current: 1, stale: 0, unchecked: 2 });
});

test('refresh refuses source drift and tampering without modifying the application or the parent run', (t) => {
  const s = refreshFixture(t); s.put(s.file, 'Changed\n'); refreshBrain(s.cfg, { to: 'review' }); s.submit('review');
  const previous = runBytes(s.root, 'default');
  const core = fs.readFileSync(path.join(s.root, 'Core/Core.csproj'), 'utf8');
  s.put('Core/Core.csproj', 'Changed during review');
  assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }), /Application snapshot changed/);
  assert.equal(fs.readFileSync(path.join(s.root, 'Core/Core.csproj'), 'utf8'), 'Changed during review');
  s.put('Core/Core.csproj', core);
  const prompt = '.project-brain/runs/review/prompts/refresh.md';
  const before = fs.readFileSync(path.join(s.root, prompt), 'utf8');
  s.put(prompt, 'tampered');
  assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }), /generated file changed/);
  s.put(prompt, before);
  refreshBrain(s.cfg, { name: 'review', accept: true });
  s.submit('review', (v) => { v.summary = 'Changed accepted submission'; });
  assert.throws(() => brainFreshness(s.cfg, { name: 'review' }), /Accepted refresh submission changed/);
  assert.deepEqual(runBytes(s.root, 'default'), previous);
});

for (const failure of ['prompt', 'state']) test(`refresh preparation resumes an interrupted ${failure} write from its journal`, (t) => {
  const s = refreshFixture(t); s.put(s.file, 'Changed\n');
  const rename = fs.renameSync;
  let stateWrites = 0;
  fs.renameSync = (from, to) => {
    if ((failure === 'prompt' && String(to).endsWith('refresh.md')) ||
        (failure === 'state' && String(to).endsWith('state.json') && ++stateWrites === 2)) throw new Error('Interrupted preparation');
    return rename(from, to);
  };
  try { assert.throws(() => refreshBrain(s.cfg, { to: 'review' }), /Interrupted preparation/); }
  finally { fs.renameSync = rename; }
  assert.equal(brainStatus(s.cfg, { name: 'review' }).status, 'interrupted');
  assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }), /preparation interrupted/);
  assert.equal(refreshBrain(s.cfg, { to: 'review' }).status, 'awaiting-review');
  assert.ok(runBytes(s.root, 'review').every(([file]) => !file.endsWith('.tmp')));
});

test('explicit batches preserve remaining stale findings until they are separately reviewed', (t) => {
  const s = refreshFixture(t); s.put(s.file, 'Changed\n'); s.put('Core/Core.csproj', 'Also changed');
  refreshBrain(s.cfg, { to: 'batch-1', findings: ['01-entry'] }); s.submit('batch-1');
  refreshBrain(s.cfg, { name: 'batch-1', accept: true });
  const first = brainFreshness(s.cfg, { name: 'batch-1' });
  assert.deepEqual(first.counts, { current: 1, stale: 1, unchecked: 1 });
  assert.equal(first.findings.find((f) => f.id === '01-core').revision.run, 'default');
  const next = refreshBrain(s.cfg, { name: 'batch-1', to: 'batch-2' });
  assert.deepEqual(next.selectedFindings, ['01-core']);
  s.submit('batch-2'); refreshBrain(s.cfg, { name: 'batch-2', accept: true });
  assert.equal(brainFreshness(s.cfg, { name: 'batch-2' }).counts.stale, 0);
});

for (const failure of ['knowledge', 'markdown', 'state']) test(`refresh acceptance recovers a failed ${failure} rename without losing history`, (t) => {
  const s = refreshFixture(t); s.put(s.file, 'Changed\n');
  refreshBrain(s.cfg, { to: 'review' }); s.submit('review');
  const parent = runBytes(s.root, 'default');
  const rename = fs.renameSync;
  let stateWrites = 0;
  fs.renameSync = (from, to) => {
    const file = String(to);
    if ((failure === 'knowledge' && file.endsWith('findings.json')) ||
        (failure === 'markdown' && file.endsWith('refresh.md')) ||
        (failure === 'state' && file.endsWith('state.json') && ++stateWrites === 2)) throw new Error('Interrupted acceptance');
    return rename(from, to);
  };
  try { assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }), /Interrupted acceptance/); }
  finally { fs.renameSync = rename; }
  assert.equal(brainStatus(s.cfg, { name: 'review' }).status, 'interrupted');
  assert.equal(brainFreshness(s.cfg, { name: 'review' }).counts.stale, 1);
  const submissionFile = path.join(s.root, '.project-brain/runs/review/submissions/refresh.json');
  const submission = fs.readFileSync(submissionFile, 'utf8');
  s.submit('review', (v) => { v.summary = 'Changed during recovery'; });
  assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }), /submission changed/);
  fs.writeFileSync(submissionFile, submission);
  s.put(s.file, 'Changed again\n');
  assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }), /Application snapshot changed/);
  s.put(s.file, 'Changed\n');
  assert.equal(refreshBrain(s.cfg, { name: 'review', accept: true }).status, 'complete');
  assert.deepEqual(runBytes(s.root, 'default'), parent);
  assert.ok(runBytes(s.root, 'review').every(([file]) => !file.endsWith('.tmp')));
  const complete = runBytes(s.root, 'review');
  refreshBrain(s.cfg, { name: 'review', accept: true });
  assert.deepEqual(runBytes(s.root, 'review'), complete);
});

test('refresh uses source and target locks and rejects symlink output roots', (t) => {
  const s = refreshFixture(t); s.put(s.file, 'Changed\n');
  const sourceLock = acquireLock(path.join(s.root, s.run, 'run.lock'));
  try { assert.throws(() => refreshBrain(s.cfg, { to: 'review' }), /holds this run lock/); }
  finally { sourceLock.release(); }
  refreshBrain(s.cfg, { to: 'review' }); s.submit('review');
  const targetLock = acquireLock(path.join(s.root, '.project-brain/runs/review/run.lock'));
  try {
    assert.throws(() => refreshBrain(s.cfg, { to: 'review' }), /holds this run lock/);
    assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }), /holds this run lock/);
  } finally { targetLock.release(); }
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-refresh-link-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  try { fs.symlinkSync(target, path.join(s.root, '.project-brain/runs/link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit symlink creation'); return; } throw error; }
  assert.throws(() => refreshBrain(s.cfg, { to: 'link' }), /symlink/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('CLI prepares and accepts a standalone refresh and rejects ambiguous flags', (t) => {
  const s = refreshFixture(t); s.put(s.file, 'Changed\n');
  const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));
  const call = (...args) => spawnSync(process.execPath, [cli, 'brain', ...args], { cwd: s.root, encoding: 'utf8' });
  const prepared = call('refresh', '--name', 'default', '--to', 'cli-review');
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).status, 'awaiting-review');
  s.submit('cli-review');
  assert.equal(call('refresh', '--name', 'cli-review', '--accept').status, 0);
  assert.equal(JSON.parse(call('freshness', '--name', 'cli-review').stdout).counts.stale, 0);
  for (const args of [
    ['refresh'], ['refresh', '--name', 'cli-review', '--accept', '--to', 'bad'],
    ['refresh', '--to', 'bad', '--findings'], ['refresh', '--to', 'bad', '--findings', 'unknown'],
    ['status', '--accept'], ['analyze', '--name', 'cli-review'],
  ]) assert.equal(call(...args).status, 1);
});

const decision = (extra = {}) => ({ id: 'keep-module', by: 'Rajesh', scope: 'App',
  statement: 'Keep this module in process', reason: 'Preserve its transaction boundary', ...extra });
const conflict = (extra = {}) => ({ id: 'module-boundary', by: 'Reporter', owner: 'Rajesh', scope: 'App',
  summary: 'Code and intended boundary disagree', left: 'Code calls the module directly', right: 'Design proposes a remote service', ...extra });
const reviewFile = (s) => path.join(s.root, '.project-brain/review/records.json');

test('review decisions retain attribution, scoped rationale and superseded history without changing analysis', (t) => {
  const s = setup(t); initBrain(s.cfg);
  const original = runBytes(s.root, 'default');
  assert.deepEqual(brainReview(s.cfg).history, []);
  assert.equal(fs.existsSync(path.join(s.root, '.project-brain/review')), false);
  assert.equal(recordReview(s.cfg, 'decision.add', decision()).created, true);
  const first = fs.readFileSync(reviewFile(s), 'utf8');
  assert.equal(recordReview(s.cfg, 'decision.add', decision()).created, false);
  assert.equal(fs.readFileSync(reviewFile(s), 'utf8'), first);
  recordReview(s.cfg, 'decision.add', decision({ id: 'split-module', by: 'Reviewer', supersedes: 'keep-module',
    statement: 'Split the module after introducing an outbox', reason: 'New delivery requirements' }));
  const view = brainReview(s.cfg, { scope: 'App/Service.cs' });
  assert.equal(view.decisions[0].by, 'Rajesh');
  assert.equal(view.decisions[0].status, 'superseded');
  assert.equal(view.decisions[0].supersededBy, 'split-module');
  assert.equal(view.decisions[1].source, 'developer');
  assert.deepEqual(view.history[0], JSON.parse(first).events[0]);
  assert.equal(brainReview(s.cfg, { scope: 'Other' }).decisions.length, 0);
  assert.equal(reviewSnapshot(s.cfg, ['App']).decisions[0].id, 'split-module');
  assert.deepEqual(runBytes(s.root, 'default'), original);
  assert.equal(brainStatus(s.cfg).nextStage, '01');
});

test('review references pin accepted finding revisions separately from developer claims', (t) => {
  const s = refreshFixture(t);
  recordReview(s.cfg, 'decision.add', decision({ findings: ['default:01-entry'] }));
  const ref = brainReview(s.cfg).decisions[0].references[0];
  assert.equal(ref.kind, 'finding');
  assert.equal(ref.record.id, '01-entry');
  assert.equal(ref.record.revision.run, 'default');
  s.put(s.file, 'Changed\n');
  refreshBrain(s.cfg, { to: 'reviewed' }); s.submit('reviewed'); refreshBrain(s.cfg, { name: 'reviewed', accept: true });
  assert.deepEqual(brainReview(s.cfg).decisions[0].references[0], ref);
  const knowledge = s.load('reviewed', 'knowledge/findings.json');
  assert.equal(knowledge.review.decisions[0].statement, decision().statement);
  assert.equal(knowledge.findings[0].statement, 'Revised finding');
  assert.throws(() => recordReview(s.cfg, 'decision.add', decision({ id: 'missing', findings: ['default:01-missing'] })), /accepted knowledge/);
  assert.throws(() => recordReview(s.cfg, 'decision.add', decision({ id: 'bad-path', findings: ['../outside:01-entry'] })), /RUN:ID/);
});

test('conflict ownership, resolutions and reopening preserve both positions and every action', (t) => {
  const s = setup(t);
  recordReview(s.cfg, 'decision.add', decision());
  recordReview(s.cfg, 'conflict.add', conflict({ decisions: ['keep-module'] }));
  assert.throws(() => recordReview(s.cfg, 'conflict.resolve', { id: 'module-boundary', by: 'Reporter',
    resolution: 'Keep it local', reason: 'Reviewed dependencies' }), /current owner/);
  recordReview(s.cfg, 'conflict.assign', { id: 'module-boundary', by: 'Rajesh', owner: 'Reviewer', reason: 'Reviewer owns this subsystem' });
  const resolved = { id: 'module-boundary', by: 'Reviewer', resolution: 'Keep the direct call', reason: 'Current decision remains applicable', decision: 'keep-module' };
  recordReview(s.cfg, 'conflict.resolve', resolved);
  const before = fs.readFileSync(reviewFile(s), 'utf8');
  assert.equal(recordReview(s.cfg, 'conflict.resolve', resolved).created, false);
  assert.equal(fs.readFileSync(reviewFile(s), 'utf8'), before);
  assert.deepEqual(brainReview(s.cfg).openConflicts, []);
  recordReview(s.cfg, 'conflict.reopen', { id: 'module-boundary', by: 'Reporter', reason: 'New integration requirements' });
  const open = brainReview(s.cfg).conflicts[0];
  assert.equal(open.left, conflict().left);
  assert.equal(open.right, conflict().right);
  assert.equal(open.owner, 'Reviewer');
  assert.equal(open.status, 'open');
  assert.ok(open.history.some((e) => e.type === 'conflict.resolve' && e.data.resolution === resolved.resolution));
  recordReview(s.cfg, 'conflict.resolve', { ...resolved, reason: 'Reviewed the new requirements' });
  assert.equal(brainReview(s.cfg).conflicts[0].history.length, 5);
});

test('invalid review data and transitions never rewrite existing history', (t) => {
  const s = setup(t); recordReview(s.cfg, 'decision.add', decision());
  const before = fs.readFileSync(reviewFile(s), 'utf8');
  for (const [type, options] of [
    ['decision.add', decision({ id: '../escape' })], ['decision.add', decision({ id: 'missing-actor', by: '' })],
    ['decision.add', decision({ id: 'missing-reason', reason: '' })], ['decision.add', decision({ id: 'bad-scope', scope: '../App' })],
    ['decision.add', decision({ statement: 'Silently rewrite old intent' })],
    ['decision.add', decision({ id: 'wrong-scope', scope: 'Other', supersedes: 'keep-module' })],
    ['conflict.add', conflict({ left: 'same', right: 'same' })], ['conflict.add', conflict({ owner: '' })],
    ['conflict.add', conflict({ decisions: ['missing'] })], ['conflict.resolve', { id: 'missing', by: 'Rajesh', reason: 'Reason', resolution: 'Resolved' }],
  ]) {
    assert.throws(() => recordReview(s.cfg, type, options));
    assert.equal(fs.readFileSync(reviewFile(s), 'utf8'), before);
  }
  recordReview(s.cfg, 'decision.add', decision({ id: 'new-decision', supersedes: 'keep-module' }));
  recordReview(s.cfg, 'conflict.add', conflict());
  assert.throws(() => recordReview(s.cfg, 'conflict.resolve', { id: 'module-boundary', by: 'Rajesh',
    reason: 'Reason', resolution: 'Resolved', decision: 'keep-module' }), /must be active/);
  assert.throws(() => recordReview(s.cfg, 'conflict.reopen', { id: 'module-boundary', by: 'Reporter', reason: 'Already open' }), /Only a resolved/);
});

test('review history detects edited events and malformed JSON instead of resetting', (t) => {
  const s = setup(t); recordReview(s.cfg, 'decision.add', decision());
  const data = readJson(reviewFile(s));
  data.events[0].data.statement = 'Tampered decision';
  writeJson(reviewFile(s), data);
  assert.throws(() => brainReview(s.cfg), /hash mismatch/);
  assert.throws(() => recordReview(s.cfg, 'decision.add', decision({ id: 'new' })), /hash mismatch/);
  atomicWrite(reviewFile(s), '{');
  assert.throws(() => brainReview(s.cfg), /Invalid JSON/);
});

test('review writes are atomic, retryable and protected by a project lock', (t) => {
  const s = setup(t); recordReview(s.cfg, 'decision.add', decision());
  const first = fs.readFileSync(reviewFile(s), 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).endsWith('records.json')) throw new Error('Review write interrupted'); return rename(from, to); };
  try { assert.throws(() => recordReview(s.cfg, 'conflict.add', conflict()), /Review write interrupted/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(reviewFile(s), 'utf8'), first);
  recordReview(s.cfg, 'conflict.add', conflict());
  assert.equal(brainReview(s.cfg).history.length, 2);
  const lock = acquireLock(path.join(s.root, '.project-brain/review/review.lock'));
  try { assert.throws(() => recordReview(s.cfg, 'decision.add', decision({ id: 'blocked' })), /review lock/); }
  finally { lock.release(); }
});

test('review storage refuses symlink roots without reading or writing their targets', (t) => {
  const s = setup(t);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-review-link-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.mkdirSync(path.join(s.root, '.project-brain'));
  try { fs.symlinkSync(target, path.join(s.root, '.project-brain/review'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') { t.skip('OS does not permit symlink creation'); return; } throw error; }
  assert.throws(() => brainReview(s.cfg), /symlink/);
  assert.throws(() => recordReview(s.cfg, 'decision.add', decision()), /symlink/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('refresh blocks unresolved conflicts and requires new context after resolution', (t) => {
  const s = refreshFixture(t);
  recordReview(s.cfg, 'decision.add', decision()); recordReview(s.cfg, 'conflict.add', conflict());
  s.put(s.file, 'Changed\n'); refreshBrain(s.cfg, { to: 'blocked' }); s.submit('blocked');
  assert.throws(() => refreshBrain(s.cfg, { name: 'blocked', accept: true }), /Unresolved review conflicts/);
  recordReview(s.cfg, 'conflict.resolve', { id: 'module-boundary', by: 'Rajesh', reason: 'Reviewed implementation', resolution: 'Keep it local', decision: 'keep-module' });
  assert.throws(() => refreshBrain(s.cfg, { name: 'blocked', accept: true }), /review context changed/);
  const history = fs.readFileSync(reviewFile(s), 'utf8');
  refreshBrain(s.cfg, { to: 'resolved' }); s.submit('resolved'); refreshBrain(s.cfg, { name: 'resolved', accept: true });
  assert.equal(fs.readFileSync(reviewFile(s), 'utf8'), history);
  const pinned = s.load('resolved', 'knowledge/review.json');
  assert.equal(pinned.decisions[0].by, 'Rajesh');
  assert.deepEqual(pinned.conflicts, []);
});

test('unrelated decisions do not invalidate scoped refresh but relevant revisions do', (t) => {
  const s = refreshFixture(t);
  // A separate module-scoped run references only App, unlike the all-project fixture.
  initBrain(s.cfg, { name: 'app', scope: 'App' });
  const state = readJson(path.join(s.root, '.project-brain/runs/app/state.json'));
  const submission = { ...s.submission('02'), stage: '01', scope: 'App', snapshotId: state.snapshotId };
  submission.findings[0].id = '01-entry';
  writeJson(path.join(s.root, '.project-brain/runs/app/submissions/01.json'), submission);
  analyzeBrain(s.cfg, { name: 'app' });
  recordReview(s.cfg, 'decision.add', decision());
  s.put(s.file, 'Changed\n'); refreshBrain(s.cfg, { name: 'app', to: 'scoped' }); s.submit('scoped');
  recordReview(s.cfg, 'decision.add', decision({ id: 'other-module', scope: 'Other' }));
  refreshBrain(s.cfg, { name: 'scoped', accept: true });
  s.put(s.file, 'Changed again\n'); refreshBrain(s.cfg, { name: 'scoped', to: 'next' }); s.submit('next');
  recordReview(s.cfg, 'decision.add', decision({ id: 'updated-module', supersedes: 'keep-module' }));
  assert.throws(() => refreshBrain(s.cfg, { name: 'next', accept: true }), /review context changed/);
  assert.equal(s.load('scoped', 'knowledge/review.json').decisions[0].id, 'keep-module');
});

test('refresh recovery cannot bypass a newly recorded conflict or the review lock', (t) => {
  const s = refreshFixture(t); s.put(s.file, 'Changed\n'); refreshBrain(s.cfg, { to: 'review' }); s.submit('review');
  const lock = acquireLock(path.join(s.root, '.project-brain/review/review.lock'));
  try { assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }), /review lock/); }
  finally { lock.release(); }
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (String(to).endsWith('findings.json')) throw new Error('Interrupted'); return rename(from, to); };
  try { assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }), /Interrupted/); }
  finally { fs.renameSync = rename; }
  recordReview(s.cfg, 'conflict.add', conflict());
  assert.throws(() => refreshBrain(s.cfg, { name: 'review', accept: true }), /Unresolved review conflicts/);
  assert.equal(s.load('review', 'state.json').refresh.accepted, undefined);
});

test('legacy prepared refreshes accept with no review records but cannot ignore new decisions', (t) => {
  const s = refreshFixture(t); s.put(s.file, 'Changed\n');
  const legacy = (name) => {
    refreshBrain(s.cfg, { to: name });
    const state = s.load(name, 'state.json');
    delete state.refresh.reviewHash; delete state.refresh.reviewScopes; delete state.controls['knowledge/review.json'];
    fs.unlinkSync(path.join(s.root, `.project-brain/runs/${name}/knowledge/review.json`));
    writeJson(path.join(s.root, `.project-brain/runs/${name}/state.json`), state);
    s.submit(name);
  };
  legacy('old-empty'); legacy('old-blocked');
  refreshBrain(s.cfg, { name: 'old-empty', accept: true });
  recordReview(s.cfg, 'decision.add', decision());
  assert.throws(() => refreshBrain(s.cfg, { name: 'old-blocked', accept: true }), /not captured/);
});

test('CLI records and shows developer history, exposes conflicts and redacts valid JSON', (t) => {
  const s = setup(t); initBrain(s.cfg);
  const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));
  const call = (...args) => spawnSync(process.execPath, [cli, 'brain', ...args], { cwd: s.root, encoding: 'utf8' });
  const added = call('decision', 'add', '--id', 'sample', '--by', 'Rajesh', '--scope', 'App', '--statement', 'token=fixture-not-a-real-secret', '--reason', 'Example');
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).event.data.statement, 'token=[redacted]');
  assert.equal(JSON.parse(call('decision', 'show', '--id', 'sample').stdout).by, 'Rajesh');
  assert.equal(call('conflict', 'add', '--id', 'boundary', '--by', 'Rajesh', '--summary', 'Boundary mismatch', '--left', 'Local call', '--right', 'Remote call').status, 0);
  assert.equal(JSON.parse(call('freshness').stdout).review.conflicts.length, 1);
  assert.equal(JSON.parse(call('status').stdout).review.conflicts.length, 1);
  assert.equal(call('conflict', 'resolve', '--id', 'boundary', '--by', 'Rajesh', '--resolution', 'Keep local', '--reason', 'Current constraints').status, 0);
  const view = JSON.parse(call('knowledge').stdout);
  assert.equal(view.history.length, 3);
  assert.deepEqual(view.openConflicts, []);
  for (const args of [['knowledge', '--name', 'default'], ['decision', 'show'], ['conflict', 'unknown'],
    ['decision', 'add', '--id', 'missing-by'], ['decision', 'add', '--findings']]) assert.equal(call(...args).status, 1);
});

test('run review context includes referenced dependencies outside the selected module', (t) => {
  const s = setup(t); initBrain(s.cfg, { scope: 'App' });
  s.submission('01', (v) => { v.findings[0].evidence = [{ path: 'Core/Core.csproj',
    hash: s.state().files['Core/Core.csproj'], startLine: 1, endLine: 1 }]; });
  analyzeBrain(s.cfg);
  recordReview(s.cfg, 'conflict.add', conflict({ scope: 'Core' }));
  assert.equal(brainReview(s.cfg, { scope: 'App' }).openConflicts.length, 0);
  assert.equal(runReviewSnapshot(s.cfg).conflicts[0].scope, 'Core');
  const cli = fileURLToPath(new URL('../bin/pipeline.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'brain', 'status'], { cwd: s.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).review.conflicts[0].scope, 'Core');
});
