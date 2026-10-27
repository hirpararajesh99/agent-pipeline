# Agent instructions for agent-pipeline

This file contains shared instructions for Codex, Claude Code, Cursor, and other AI coding tools working on the
**agent-pipeline codebase itself** (not on a user project that runs the pipeline).

Read `PRODUCT.md` first — it explains what the system does and why each file exists.

## Instruction loading and workflow

- Keep repository instructions here; do not recreate a separate `CLAUDE.md` wrapper.
- Codex discovers `AGENTS.md` automatically. Claude Code v2.1.277+ supports it directly
  when its built-in AGENTS.md support is enabled and no `CLAUDE.md`, `.claude/CLAUDE.md`,
  or `CLAUDE.local.md` in the working directory or its ancestors takes precedence.
  Check `/memory` for loaded files; older sessions need an upgrade or a local compatibility import.
- Read the files being changed and follow existing patterns before implementing a change.
- For Project Brain work, read `docs/product/PROJECT-BRAIN.md`,
  `docs/product/ARCHITECTURE.md`, `docs/product/ROADMAP.md`, and
  `docs/features/project-brain/README.md`. Distinguish implemented behavior from planned work.
- Check the working tree first and preserve unrelated user changes.
- Use `npm test` for the full offline suite. Use web research when the task requires current
  documentation; browser inspection can be useful for the dashboard in `src/dashboard.html`.

References: [Codex instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [Claude Code instructions](https://code.claude.com/docs/en/memory#agentsmd).

---

## Repository layout

```
bin/pipeline.mjs              Entry point (just imports cli.mjs and calls main)
src/
  cli.mjs                     All CLI commands (init, doctor, run, loop, serve, ticket, docs)
  orchestrator.mjs            Core pipeline loop: planTick, codeTick, qaAndCheckIn, maybeDeploy
  server.mjs                  HTTP + SSE server for the browser dashboard
  dashboard.html              Browser dashboard (vanilla HTML/CSS/JS — no build step)
  prompt.mjs                  Builds agent prompts from ticket + context + config rules
  artifacts.mjs               Validates agent handoff files (park.json, qa.json, lesson.json)
  config.mjs                  Config schema (DEFAULTS), deepMerge, loadConfig, validate
  docs.mjs                    Feature README seeding, keyword scoring, lesson indexing
  brain.mjs                   Project Brain bootstrap, guided analysis and synthesis
  indexer.mjs, indexers/      Project index, reference graph, impact lookup and stack analyzers
  plan.mjs                    Plan validation and persistence
  preflight.mjs               Ticket readiness checks
  state.mjs                   Atomic JSON state store keyed by filename in stateDir
  lock.mjs                    File-based lock with heartbeat and stale-lock recovery
  exec.mjs                    Shell runner: runShell (with log), runCommand, commandExists
  util.mjs                    readJson, writeJson, redact, sanitizeText, render, isInside
  adapters/
    agents/index.mjs          BUILTIN presets + providerSpec + buildInvocation + runAgent
    trackers/index.mjs        createTracker factory (clickup | file)
    trackers/clickup.mjs      ClickUp REST API: list, get, getComments, setStatus, comment
    trackers/file.mjs         JSON-file tracker for demos and tests
    vcs/index.mjs             createVcs factory (git | command | none)
    vcs/git.mjs               Git adapter: prepare (worktree), checkIn (commit + push + PR)
    vcs/command.mjs           Custom-command VCS adapter (TFVC etc.)
    vcs/none.mjs              No-op VCS (returns workDir as-is, no check-in)
templates/                    Files copied verbatim by `agent-pipeline init`
test/
  pipeline.test.mjs           Pipeline integration tests using Node's built-in test runner
  brain.test.mjs              Project Brain validation and workflow tests
  fixtures/fake-agent.mjs     Fake AI agent used in tests (reads FAKE_MODE env var)
  fixtures/fake-qa.mjs        Fake QA script used in tests (reads FAKE_QA env var)
```

---

## Hard rules for working on this codebase

1. **Zero npm dependencies.** Every file uses only `node:*` built-ins. Do not add `import` from
   any npm package. If you think you need one, ask — the answer is almost always "use the built-in."

2. **ES modules only.** All files use `.mjs` extension and `import`/`export`. No CommonJS.

3. **Node 18.17+ target.** Use only APIs available in Node 18.17. No top-level `await` in modules
   that are imported by `cli.mjs` (it breaks the sync `loadConfig` path).

4. **Atomic state writes.** Never call `fs.writeFileSync` directly on a state file.
   Use `writeJson` from `util.mjs` which calls `atomicWrite` (write-then-rename).

5. **Never trust agent output.** Any data written by an agent must be validated before being used
   to write files, set statuses, or run commands. See `artifacts.mjs` and `plan.mjs`.

6. **Redact secrets before logging or posting.** Use `redact(text, ctx.secrets)` from `util.mjs`
   before any text goes to a tracker comment or a log that could be read by a human or another agent.

7. **Tests must stay green.** Run `npm test` after every change. The full suite must pass.
   Tests use the `fake-agent` and `fake-qa` fixtures — no real AI tool or network required.

8. **Preserve existing comments and docstrings** unless you are changing the code they document.

9. **Preserve synchronous configuration.** Do not make `loadConfig` or `buildConfig` async.

10. **Preserve state storage and adapter isolation.** Keep state as a flat directory of JSON
    files and do not introduce module-level mutable state in adapters.

11. **Protect shared sanitization.** Update relevant tests whenever changing `sanitizeText`
    or `redact` behavior.

---

## Coding conventions

### Imports
Always import from the `node:` namespace:
```js
import fs from 'node:fs';
import path from 'node:path';
```

### Error handling
- Functions that can fail throw `Error` with a clear message
- Pipeline stages catch errors and call `failTicket` / `failPlan` (which handle retries and blocking)
- Never swallow errors silently unless the context explicitly says it is safe to do so
  (e.g. posting a tracker comment — a comment failure must not stop the pipeline)

### Config access
Always access config through the `cfg` object passed down from `runOnce`. Never read
`pipeline.config.json` directly inside orchestration code.

### State access
Always use `new State(cfg.stateDir)` and its `get`/`set` methods. Never read state JSON files
directly with `fs.readFileSync` inside orchestration code.

### Adding a new CLI command
1. Add the help text entry in the `HELP` string in `cli.mjs`
2. Add the `if (cmd === '...')` branch in `main()`
3. Write the handler as a named async function below `main()`

### Adding a new tracker adapter
1. Create `src/adapters/trackers/<name>.mjs` exporting a factory function `<name>Tracker(cfg)`
2. The factory must return: `{ list(keys), get(id), getComments(id), setStatus(id, key), comment(id, text) }`
3. Register it in `src/adapters/trackers/index.mjs`
4. Add the type to the validation in `src/config.mjs` → `validate()`

### Adding a new VCS adapter
1. Create `src/adapters/vcs/<name>.mjs` exporting a factory function `create<Name>Vcs(cfg)`
2. The factory must return: `{ prepare({ ticket }), checkIn({ ticket, workDir, files, message, branch }) }`
3. Register it in `src/adapters/vcs/index.mjs`
4. Add the type to the validation in `src/config.mjs` → `validate()`

### Adding a new AI agent preset
Add the preset to the `BUILTIN` object in `src/adapters/agents/index.mjs`:
```js
myagent: {
  command: 'myagent',         // executable name
  args: ['-p', '{promptPointer}', '{modelArgs}'],
  promptMode: 'stdin',        // 'stdin' or 'pointer'
  modelArgs: ['--model', '{model}'],
},
```
Fields can be overridden per-project via `agent.providers.<name>` in `pipeline.config.json`.

---

## Test environment

The test suite uses `node:test` (built into Node 18+):

```bash
npm test
# or
node --test test/pipeline.test.mjs test/brain.test.mjs
```

Each test uses `setup()` which:
- Creates a temp directory with a fresh workspace
- Writes a `tickets.json` with a test ticket
- Builds a config pointing at the `fake-agent` and `fake-qa` fixtures
- Returns helpers: `ticket()`, `edit()`, `state()`, `work()`

Control fake agent behaviour with environment variables before calling `runOnce`:
```js
process.env.FAKE_MODE = 'good';      // normal coding agent output
process.env.FAKE_MODE = 'needinfo';  // agent asks a question
process.env.FAKE_MODE = 'badpath';   // agent writes a bad file path
process.env.FAKE_MODE = 'quota';     // agent exits with quota-hit message
process.env.FAKE_QA   = '0';         // QA passes
process.env.FAKE_QA   = '2';         // QA fails
process.env.FAKE_QA   = '3';         // QA blocked (environment)
process.env.FAKE_PLAN = 'clear';     // plan agent: clear decision
process.env.FAKE_PLAN = 'needinfo';  // plan agent: needs more info
process.env.FAKE_PLAN = 'highrisk';  // plan agent: high-risk plan
```

---

## Common tasks

### Run all tests
```bash
npm test
```

### Test the CLI without installing
```bash
node bin/pipeline.mjs help
node bin/pipeline.mjs init       # in a test project folder
node bin/pipeline.mjs doctor
node bin/pipeline.mjs run --dry-run
```

### Lint (manual — no linter is configured, use your judgment)
- No unused imports
- No `console.log` inside library code (only in CLI output and server startup)
- No hardcoded paths (use `path.join`, `path.resolve`, config values)

### Simulate a full pipeline run (no real AI)
```bash
cd /tmp/test-project
agent-pipeline init
# edit pipeline.config.json: set qa.command to "node -e \"0\""
agent-pipeline doctor
agent-pipeline run --dry-run
agent-pipeline run --job plan
agent-pipeline run --job code
```
