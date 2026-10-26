import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.mjs';
import { initBrain, analyzeBrain, brainStatus, runBrain, BRAIN_STAGES } from '../src/brain.mjs';
import { readJson, writeJson } from '../src/util.mjs';
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
