# Contributing to agent-pipeline

Thank you for contributing! This document explains how to get started, the rules to follow,
and how to extend the pipeline with new adapters.

---

## Getting started

```bash
# 1. Clone the repo
git clone https://github.com/hirpararajesh99/agent-pipeline.git
cd agent-pipeline

# 2. Check your Node version — must be 18.17 or newer
node --version

# 3. Run the tests (no install needed — zero dependencies)
npm test

# 4. Link the CLI globally so you can test it in a real project
npm link

# 5. In a separate test project folder:
mkdir /tmp/test-project && cd /tmp/test-project
agent-pipeline init
agent-pipeline doctor
```

---

## Project philosophy (read before writing any code)

| Principle | Rule |
|---|---|
| Zero npm dependencies | Only `node:*` built-ins. Never add an npm package. |
| ES modules only | `.mjs` files, `import`/`export`, no CommonJS |
| Node 18.17 minimum | No APIs newer than Node 18.17 |
| Atomic state writes | Use `writeJson` from `util.mjs`, never raw `fs.writeFileSync` on state |
| Trust nothing from the AI | Validate all agent output before using it |
| Tests must pass | The full suite must pass after every change (`npm test`) |

---

## How to run tests

```bash
npm test
# equivalent to:
node --test test/pipeline.test.mjs test/brain.test.mjs test/lessons.test.mjs
```

No real AI tool, tracker, or network is required for the tests.
The fake agent (`test/fixtures/fake-agent.mjs`) and fake QA (`test/fixtures/fake-qa.mjs`)
simulate every scenario the pipeline handles.

---

## How to add a new tracker adapter (e.g. Jira, GitHub Issues, Linear)

1. **Create** `src/adapters/trackers/<name>.mjs` and export a factory:
```js
export function <name>Tracker(cfg) {
  return {
    async list(keys)               { /* return [{ id, title, description, status, statusKey }] */ },
    async get(id)                  { /* return { id, title, description, status, statusKey } */ },
    async getComments(id)          { /* return ['comment text', ...] */ },
    async setStatus(id, statusKey) { /* move the ticket */ },
    async comment(id, text)        { /* post a comment */ },
  };
}
```

2. **Register** it in `src/adapters/trackers/index.mjs`:
```js
import { <name>Tracker } from './<name>.mjs';
// add to the factory switch
case '<name>': return <name>Tracker(cfg);
```

3. **Validate** it in `src/config.mjs` → `validate()`:
```js
if (!['file', 'clickup', '<name>'].includes(cfg.tracker.type)) ...
```

4. **Write a test** — at minimum one test that uses your tracker via `setup({ tracker: { type: '<name>', ... } })`.

5. **Document it** in `README.md` under the tracker section and in `PRODUCT.md`.

---

## How to add a new VCS adapter

1. **Create** `src/adapters/vcs/<name>.mjs` and export a factory:
```js
export function create<Name>Vcs(cfg) {
  return {
    async prepare({ ticket })                                  { /* return { workDir, branch? } */ },
    async checkIn({ ticket, workDir, files, message, branch }) { /* return { ref } */ },
  };
}
```

2. **Register** it in `src/adapters/vcs/index.mjs`.
3. **Validate** it in `src/config.mjs` → `validate()`.

---

## How to add a new AI agent preset

In `src/adapters/agents/index.mjs`, add to the `BUILTIN` object:
```js
myagent: {
  command:    'myagent-cli',
  args:       ['--prompt', '-', '{modelArgs}'],
  promptMode: 'stdin',           // 'stdin' or 'pointer'
  modelArgs:  ['--model', '{model}'],
  sandbox:    '',                // optional
  plan:       { args: [...] },   // optional: override for planning job
},
```

---

## Pull request checklist

- [ ] `npm test` passes (the full suite is green)
- [ ] No new npm dependencies added
- [ ] New adapter has at least one test
- [ ] `README.md` updated if the change is user-visible
- [ ] `CHANGELOG.md` entry added under `## Unreleased`
- [ ] Existing comments and docstrings preserved where code is unchanged

---

## Commit message format

```
<type>: <short description>

<optional body>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`

Examples:
```
feat: add Jira tracker adapter
fix: restore ticket status when plan agent times out
docs: add Linear adapter example to CONTRIBUTING.md
test: cover quota-hold on plan job
```

---

## File naming conventions

| What | Convention | Example |
|---|---|---|
| Source files | camelCase `.mjs` | `orchestrator.mjs` |
| Adapter factory exports | `create<Name>` or `<name>Tracker` | `createGitVcs`, `clickupTracker` |
| Test helpers | short, local to test file | `setup()`, `env()` |
| Template files | uppercase or kebab-case | `AGENTS.md`, `pipeline.config.example.json` |

---

## Getting help

- Open a GitHub issue describing the problem or feature
- For large changes, open an issue first to discuss before writing code
- Check `README.md` → Known limits for things that are intentionally not supported yet
