import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../src/config.mjs';
import { runOnce } from '../src/orchestrator.mjs';
import { acquireLock } from '../src/lock.mjs';
import { readJson, writeJson, sanitizeText, redact, isInside } from '../src/util.mjs';
import { buildInvocation } from '../src/adapters/agents/index.mjs';
import { findContext, parseFrontMatter } from '../src/docs.mjs';
import { preflightTicket } from '../src/preflight.mjs';
import { validateArtifacts } from '../src/artifacts.mjs';
import { buildProjectIndex, findImpact, findIndexContext, writeProjectIndex } from '../src/indexer.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const node = `"${process.execPath}"`;
const T = (id = 'T1', status = 'code ready', extra = {}) => ({ id, title: 'Add widget export', description: 'Add widget export to the widget list', status, comments: [], ...extra });

function setup(extra = {}, tickets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-'));
  fs.mkdirSync(path.join(dir, 'work'));
  writeJson(path.join(dir, 'tickets.json'), tickets ?? [T()]);
  const cfg = buildConfig({
    workspace: 'work',
    stateDir: 'state',
    agent: { provider: 'fake', providers: { fake: { command: process.execPath, args: [path.join(fixtures, 'fake-agent.mjs')], promptMode: 'stdin' } }, maxMinutes: 1 },
    tracker: { type: 'file', file: 'tickets.json' },
    plan: { enabled: false },
    qa: { command: `${node} "${path.join(fixtures, 'fake-qa.mjs')}"` },
    ...extra,
  }, dir);
  const tickets_ = () => readJson(path.join(dir, 'tickets.json'));
  const ticket = (id = 'T1') => tickets_().find((t) => t.id === id);
  const edit = (id, fn) => { const all = tickets_(); fn(all.find((t) => t.id === id)); writeJson(path.join(dir, 'tickets.json'), all); };
  const state = (n) => readJson(path.join(dir, 'state', `${n}.json`), null);
  const work = (...p) => path.join(dir, 'work', ...p);
  return { dir, cfg, ticket, edit, state, work };
}
const env = (mode = 'good', qa = 0, plan = 'clear', lesson = '') => { process.env.FAKE_MODE = mode; process.env.FAKE_QA = String(qa); process.env.FAKE_PLAN = plan; process.env.FAKE_LESSON = lesson; };
const PLAN_ON = { plan: { enabled: true } };

// ------------------------------------------------------------ core (plan disabled, v0.1 behaviour)

test('without a plan: code, verify, QA, check in, ai test pass', async () => {
  env();
  const s = setup();
  const r = await runOnce(s.cfg);
  assert.equal(r.status, 'pass');
  assert.equal(s.ticket().status, 'ai test pass');
  assert.equal(s.state('deploy-ready').length, 1);
  assert.equal(s.state('inflight'), null);
});

test('QA failure goes to redo, third failure blocks for a human', async () => {
  env('good', 2);
  const s = setup({ docs: { requireLessonOnRedo: false } });
  assert.equal((await runOnce(s.cfg)).status, 'redo');
  assert.equal(s.ticket().status, 'redo');
  assert.equal((await runOnce(s.cfg)).status, 'redo');
  assert.equal((await runOnce(s.cfg)).status, 'blocked');
  assert.equal(s.ticket().status, 'blocked');
  assert.ok(s.ticket().comments.every((c) => c.startsWith('[agent-pipeline] ')));
});

test('QA exit 3 (environment) blocks without counting as a failed attempt', async () => {
  env('good', 3);
  const s = setup();
  assert.equal((await runOnce(s.cfg)).status, 'blocked');
  assert.equal((s.state('attempts') ?? {}).T1, undefined);
});

test('need info from the coding agent: question posted, status set', async () => {
  env('needinfo');
  const s = setup();
  assert.equal((await runOnce(s.cfg)).status, 'need-info');
  assert.equal(s.ticket().status, 'need info');
  assert.match(s.ticket().comments[0], /Which account/);
});

test('path traversal in park.json and missing asserts are rejected', async () => {
  env('badpath');
  let s = setup();
  let r = await runOnce(s.cfg);
  assert.equal(r.status, 'redo');
  assert.match(r.reason, /outside the workspace/);
  env('noassert');
  s = setup();
  r = await runOnce(s.cfg);
  assert.match(r.reason, /assert/);
});

test('a failing unit-test gate sends the ticket to redo even if the agent claims success', async () => {
  env();
  const s = setup({ gates: { unitTests: `${node} -e "process.exit(1)"` } });
  const r = await runOnce(s.cfg);
  assert.equal(r.status, 'redo');
  assert.match(r.reason, /unit tests/);
});

test('quota hit holds that provider and restores the ticket', async () => {
  env('quota');
  const s = setup();
  assert.equal((await runOnce(s.cfg)).status, 'quota-hold');
  assert.equal(s.ticket().status, 'code ready');
  assert.equal(s.state('hold-fake').reason, 'quota');
  assert.equal((await runOnce(s.cfg)).status, 'provider-hold');
});

test('a missing AI program does not use up an attempt', async () => {
  env();
  const s = setup({ agent: { provider: 'ghost', providers: { ghost: { command: 'definitely-not-installed-xyz', args: [] } } } });
  const r = await runOnce(s.cfg);
  assert.equal(r.status, 'agent-unavailable');
  assert.equal(s.ticket().status, 'code ready');
  assert.equal((s.state('attempts') ?? {}).T1, undefined);
  assert.equal(s.state('hold-ghost').reason, 'unavailable');
});

test('redo is picked before new work; a held redo does not block new work below the threshold', async () => {
  env();
  const s = setup({ limits: { pauseReadyWhenRedoAtLeast: 2 } }, [T('A', 'code ready'), T('B', 'redo')]);
  assert.equal((await runOnce(s.cfg, {}, { dryRun: true })).ticket, 'B');
  writeJson(path.join(s.dir, 'state', 'hold.json'), ['B']);
  assert.equal((await runOnce(s.cfg, {}, { dryRun: true })).ticket, 'A');
});

test('batch deploy signs off the whole batch', async () => {
  env();
  const s = setup({ deploy: { command: `${node} -e "0"`, batchMin: 1 } });
  await runOnce(s.cfg);
  assert.equal(s.ticket().status, 'sign off');
  assert.equal(s.state('deploy-ready').length, 0);
});

// ------------------------------------------------------------ plan job and documentation

test('plan then code: plan is made, code meets it, docs are written and checked in with the code', async () => {
  env();
  const s = setup(PLAN_ON, [T('T1', 'not started')]);
  const p = await runOnce(s.cfg, {}, { job: 'plan' });
  assert.equal(p.results[0].status, 'planned');
  assert.equal(s.ticket().status, 'code ready');
  assert.equal(s.state('plan-T1').acceptance.length, 2);
  assert.match(s.ticket().comments[0], /Plan ready/);

  const c = await runOnce(s.cfg, {}, { job: 'code' });
  assert.equal(c.status, 'pass');
  assert.equal(s.ticket().status, 'ai test pass');
  const readme = fs.readFileSync(s.work('docs/features/widgets/README.md'), 'utf8');
  assert.match(readme, /Widgets are listed on the home page/);
  assert.match(readme, /Widgets now handled for T1/);
  assert.match(fs.readFileSync(s.work('docs/features/widgets/tickets/T1.md'), 'utf8'), /AC2: Related list updated/);
  assert.match(fs.readFileSync(s.work('docs/features/widgets/CHANGELOG.md'), 'utf8'), /T1/);
  assert.match(fs.readFileSync(s.work('docs/FEATURES.md'), 'utf8'), /widgets/);
  const ev = fs.readFileSync(path.join(s.dir, 'state', 'events.jsonl'), 'utf8');
  // The feature docs plus the generated project-index, graph, and summary are checked in.
  assert.match(ev, /"checked-in".*"files":8/s);
});

test('need-info plan: question posted, a human answer reaches the next planning run', async () => {
  env('good', 0, 'needinfo');
  const s = setup(PLAN_ON, [T('T1', 'not started')]);
  const p = await runOnce(s.cfg, {}, { job: 'plan' });
  assert.equal(p.results[0].status, 'need-info');
  assert.equal(s.ticket().status, 'need info');
  assert.match(s.ticket().comments[0], /Which account/);
  s.edit('T1', (t) => { t.comments.push('Use the admin account'); t.status = 'resume'; });
  env('good', 0, 'clear');
  const p2 = await runOnce(s.cfg, {}, { job: 'plan' });
  assert.equal(p2.results[0].status, 'planned');
  assert.match(fs.readFileSync(path.join(s.dir, 'state', 'prompts', 'T1-plan.md'), 'utf8'), /Use the admin account/);
  assert.equal(s.state('plan-T1').version, 2);
  assert.ok(!fs.readFileSync(path.join(s.dir, 'state', 'prompts', 'T1-plan.md'), 'utf8').includes('[agent-pipeline] Question'), 'pipeline comments are not shown as human comments');
});

test('high-risk plan waits for approval; a human moving it to ready lets coding proceed', async () => {
  env('good', 0, 'highrisk');
  const s = setup(PLAN_ON, [T('T1', 'not started')]);
  assert.equal((await runOnce(s.cfg, {}, { job: 'plan' })).results[0].status, 'approval');
  assert.equal(s.ticket().status, 'needs approval');
  assert.equal((await runOnce(s.cfg, {}, { job: 'code' })).status, 'idle');
  s.edit('T1', (t) => { t.status = 'code ready'; });
  assert.equal((await runOnce(s.cfg, {}, { job: 'code' })).status, 'pass');
});

test('a planning agent that edits project files is stopped and the ticket is blocked', async () => {
  env('good', 0, 'edit');
  const s = setup(PLAN_ON, [T('T1', 'not started')]);
  const r = await runOnce(s.cfg, {}, { job: 'plan' });
  assert.equal(r.results[0].status, 'blocked');
  assert.match(r.results[0].reason, /hacked\.txt/);
  assert.equal(s.ticket().status, 'blocked');
});

test('an invalid plan is retried and then blocked', async () => {
  env('good', 0, 'bad');
  const s = setup(PLAN_ON, [T('T1', 'not started')]);
  assert.equal((await runOnce(s.cfg, {}, { job: 'plan' })).results[0].status, 'plan-failed');
  assert.equal(s.ticket().status, 'not started');
  await runOnce(s.cfg, {}, { job: 'plan' });
  assert.equal((await runOnce(s.cfg, {}, { job: 'plan' })).results[0].status, 'blocked');
});

test('a ticket put straight into ready is planned first, then coded', async () => {
  env();
  const s = setup(PLAN_ON, [T('T1', 'code ready')]);
  const r = await runOnce(s.cfg, {}, { job: 'code' });
  assert.equal(r.status, 'pass');
  assert.ok(s.state('plan-T1'));
});

test('QA must cover every acceptance check; README must be updated', async () => {
  env('nocover');
  let s = setup(PLAN_ON, [T('T1', 'not started')]);
  await runOnce(s.cfg, {}, { job: 'plan' });
  let r = await runOnce(s.cfg, {}, { job: 'code' });
  assert.equal(r.status, 'redo');
  assert.match(r.reason, /does not cover AC2/);
  env('nodocs');
  s = setup(PLAN_ON, [T('T1', 'not started')]);
  await runOnce(s.cfg, {}, { job: 'plan' });
  r = await runOnce(s.cfg, {}, { job: 'code' });
  assert.match(r.reason, /README .* was not updated/);
});

test('redo needs a lesson; the lesson is filed in the index when the ticket finally passes', async () => {
  env('good', 2);
  const s = setup(PLAN_ON, [T('T1', 'not started')]);
  await runOnce(s.cfg, {}, { job: 'plan' });
  assert.equal((await runOnce(s.cfg, {}, { job: 'code' })).status, 'redo');
  env('good', 0, 'clear', 'skip');
  const r = await runOnce(s.cfg, {}, { job: 'code' });
  assert.match(r.reason, /lesson\.json is missing/);
  env('good', 0);
  assert.equal((await runOnce(s.cfg, {}, { job: 'code' })).status, 'pass');
  const index = fs.readFileSync(s.work('docs/memory/INDEX.md'), 'utf8');
  assert.match(index, /\| T1 \| widgets \|/);
  assert.equal(fs.readdirSync(s.work('docs/memory/lessons')).length, 1);
});

test('an enhancement later: the agent is pointed at the existing README, changelog, earlier plan and lesson', async () => {
  env('good', 2);
  const s = setup(PLAN_ON, [T('T1', 'not started')]);
  await runOnce(s.cfg, {}, { job: 'plan' });
  await runOnce(s.cfg, {}, { job: 'code' });
  env('good', 0);
  await runOnce(s.cfg, {}, { job: 'code' });
  assert.equal(s.ticket().status, 'ai test pass');

  const all = readJson(path.join(s.dir, 'tickets.json'));
  all.push(T('T2', 'not started', { title: 'Widget list needs a search box', description: 'Add search to the widget list' }));
  writeJson(path.join(s.dir, 'tickets.json'), all);
  await runOnce(s.cfg, {}, { job: 'plan' });
  const prompt = fs.readFileSync(path.join(s.dir, 'state', 'prompts', 'T2-plan.md'), 'utf8');
  assert.match(prompt, /docs\/features\/widgets\/README\.md/);
  assert.match(prompt, /CHANGELOG\.md/);
  assert.match(prompt, /tickets\/T1\.md/);
  assert.match(prompt, /lessons\/.*check-the-related-list/);
  const ctx = findContext(s.work(), s.cfg, { id: 'T2', title: 'Widget list needs a search box', description: '' });
  assert.equal(ctx.features[0].slug, 'widgets');
});

test('plan and code jobs use separate locks', async () => {
  env();
  const s = setup(PLAN_ON, [T('T1', 'not started')]);
  const l = acquireLock(path.join(s.dir, 'state', 'code.lock'));
  assert.equal((await runOnce(s.cfg, {}, { job: 'code' })).status, 'locked');
  assert.equal((await runOnce(s.cfg, {}, { job: 'plan' })).results[0].status, 'planned');
  l.release();
});

// ------------------------------------------------------------ helpers

test('lock: refused while held; dead pid is recovered', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'l.lock');
  const a = acquireLock(f);
  assert.ok(a);
  assert.equal(acquireLock(f), null);
  a.release();
  fs.writeFileSync(f, JSON.stringify({ pid: 999999, host: os.hostname(), heartbeat: Date.now() }));
  assert.ok(acquireLock(f));
});

test('helpers: BOM, sanitise, redact, path check, front matter', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'j-')), 'a.json');
  fs.writeFileSync(f, '\ufeff{"a":1}');
  assert.deepEqual(readJson(f), { a: 1 });
  assert.equal(sanitizeText('fix "x"; rm -rf $(id) `y`'), 'fix x rm -rf (id) y');
  assert.match(redact('token=abc123def password: hunter22'), /\[redacted\].*\[redacted\]/);
  assert.equal(isInside('/a/b', '/a/b/../c'), false);
  assert.deepEqual(parseFrontMatter('---\nfeature: x\nkeywords: [a, b]\n---\nbody').meta, { feature: 'x', keywords: ['a', 'b'] });
});

test('agent presets build the expected commands, plan job gets read-only tools for Claude', () => {
  const cfg = buildConfig({ tracker: { type: 'file' }, qa: { command: 'x' }, agent: { model: 'm1' } }, os.tmpdir());
  const pf = path.join(os.tmpdir(), 'p.md');
  fs.writeFileSync(pf, 'hello');
  const codex = buildInvocation('codex', cfg, { promptFile: pf, cwd: '.', ticket: 'T1' });
  assert.deepEqual(codex.args.slice(0, 4), ['-a', 'never', 'exec', '--skip-git-repo-check']);
  assert.equal(codex.args.at(-1), '-');
  assert.ok(codex.args.includes('m1'));
  const claudeCode = buildInvocation('claude', cfg, { promptFile: pf, cwd: '.', ticket: 'T1', job: 'code' });
  const claudePlan = buildInvocation('claude', cfg, { promptFile: pf, cwd: '.', ticket: 'T1', job: 'plan' });
  assert.ok(claudeCode.args.includes('Bash,Edit,Write,Read,Glob,Grep'));
  assert.ok(claudePlan.args.includes('Read,Glob,Grep,Write'));
  const cursor = buildInvocation('cursor', cfg, { promptFile: pf, cwd: '.', ticket: 'T1' });
  assert.equal(cursor.input, null);
  assert.match(cursor.args.at(-1), /Read the file/);
});

test('preflight stops incomplete tickets before an agent starts and flags risk terms', async () => {
  env();
  const s = setup(PLAN_ON, [T('T1', 'not started', { description: 'too short' })]);
  const r = await runOnce(s.cfg, {}, { job: 'plan' });
  assert.equal(r.results[0].status, 'need-info');
  assert.equal(s.ticket().status, 'need info');
  assert.equal(s.state('preflight-T1').ok, false);
  assert.match(s.ticket().comments[0], /Before an AI agent is started/);

  const p = preflightTicket(s.cfg, T('T2', 'not started', { title: 'Change database permissions', description: 'Update the database role permissions for the reporting user.' }), { features: [], lessons: [] });
  assert.equal(p.ok, true);
  assert.deepEqual(p.risks, ['database or migration', 'authentication or permissions']);
});

test('park.json accepts safe deletedFiles and rejects a deletion that still exists', () => {
  const s = setup();
  const artifacts = s.work('.pipeline', 'tickets', 'T1');
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(s.work('kept.txt'), 'kept');
  writeJson(path.join(artifacts, 'park.json'), {
    ticketId: 'T1', summary: 'Removed obsolete branding asset', files: ['kept.txt'], deletedFiles: ['old-logo.png'],
  });
  writeJson(path.join(artifacts, 'qa.json'), { steps: [{ action: 'check', assert: 'passes' }] });
  let r = validateArtifacts({ cfg: s.cfg, ticketId: 'T1', workDir: s.work(), artifactsDir: artifacts });
  assert.equal(r.ok, true);
  assert.deepEqual(r.deletedFiles, ['old-logo.png']);

  fs.writeFileSync(s.work('old-logo.png'), 'still here');
  r = validateArtifacts({ cfg: s.cfg, ticketId: 'T1', workDir: s.work(), artifactsDir: artifacts });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /deleted file still exists/);
});

test('project index maps local HTML, CSS and JavaScript references for compact impact context', () => {
  const s = setup();
  fs.mkdirSync(s.work('assets'), { recursive: true });
  fs.writeFileSync(s.work('index.html'), '<link href="assets/site.css"><script src="assets/app.js"></script><img src="assets/logo.png">');
  fs.writeFileSync(s.work('assets', 'site.css'), '.hero { background: url("logo.png"); }');
  fs.writeFileSync(s.work('assets', 'app.js'), 'import "./helper.js";');
  fs.writeFileSync(s.work('assets', 'helper.js'), 'export const ready = true;');
  fs.writeFileSync(s.work('assets', 'logo.png'), 'png');

  const index = buildProjectIndex(s.work(), s.cfg);
  assert.ok(index.graph.edges.some((e) => e.from === 'index.html' && e.to === 'assets/site.css'));
  assert.ok(index.graph.edges.some((e) => e.from === 'assets/site.css' && e.to === 'assets/logo.png'));
  assert.deepEqual(findImpact(index, 'assets/site.css').related.sort(), ['assets/logo.png', 'index.html']);
  const context = findIndexContext(index, s.cfg, { title: 'Update logo', description: 'Replace the logo image', comments: [] });
  assert.ok(context.files.some((f) => f.path === 'assets/logo.png'));
  const written = writeProjectIndex(s.work(), s.cfg, index);
  assert.equal(written.length, 3);
  assert.ok(fs.existsSync(s.work('docs', 'project-index.json')));
  assert.ok(fs.existsSync(s.work('docs', 'project-graph.json')));
});

test('project index maps legacy and modern .NET project evidence', () => {
  const s = setup();
  fs.mkdirSync(s.work('src'), { recursive: true });
  fs.mkdirSync(s.work('Lib'), { recursive: true });
  fs.writeFileSync(s.work('App.sln'), 'Project("{x}") = "Web", "src\\Web.csproj", "{y}"');
  fs.writeFileSync(s.work('src', 'Web.csproj'), '<Project><ItemGroup><ProjectReference Include="../Lib/Lib.csproj" /></ItemGroup></Project>');
  fs.writeFileSync(s.work('Lib', 'Lib.csproj'), '<Project />');
  fs.writeFileSync(s.work('src', 'Services.cs'), 'namespace App.Services; public interface ICustomerService {} public class CustomerService : ICustomerService {}');
  fs.writeFileSync(s.work('src', 'Program.cs'), 'builder.Services.AddScoped<ICustomerService, CustomerService>(); app.MapGet("/health", () => "ok");');
  fs.writeFileSync(s.work('src', 'Legacy.aspx'), '<%@ Page CodeBehind="Legacy.aspx.cs" %>');
  fs.writeFileSync(s.work('src', 'Legacy.aspx.cs'), 'namespace App; public class Legacy {}');

  const index = buildProjectIndex(s.work(), s.cfg);
  assert.ok(index.graph.edges.some((e) => e.from === 'App.sln' && e.to === 'src/Web.csproj' && e.kind === 'solution-project'));
  assert.ok(index.graph.edges.some((e) => e.from === 'src/Web.csproj' && e.to === 'Lib/Lib.csproj' && e.kind === 'project-reference'));
  assert.ok(index.graph.edges.some((e) => e.from === 'src/Legacy.aspx' && e.to === 'src/Legacy.aspx.cs' && e.kind === 'code-behind'));
  assert.ok(index.graph.edges.some((e) => e.from === 'src/Program.cs' && e.to === 'route:/health' && e.kind === 'defines-route'));
});
