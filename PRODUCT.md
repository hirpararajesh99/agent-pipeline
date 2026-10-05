# agent-pipeline — Product Document

## What is this?

`agent-pipeline` is a **tool-agnostic, cross-platform orchestration layer** that lets any AI coding
agent (Codex, Claude Code, Cursor, or a custom CLI) work through a backlog of tickets safely,
one at a time, with full auditability.

It automates the loop that every development team runs manually today:

```
Pick ticket → Plan → Code → Build → Test → Check in → Deploy → Repeat
```

The pipeline drives this loop unattended. A human defines the tickets and reviews the output.
The AI does the implementation.

---

## Problem it solves

When developers use AI coding tools today, the workflow is fully manual:

1. Developer picks a ticket and writes a prompt by hand
2. Runs the AI tool
3. Manually inspects the output
4. Runs the build and tests
5. Commits and updates the ticket status
6. Repeats 40-80 times per sprint

This is slow, error-prone, and inconsistent. The pipeline replaces steps 1-6 with an automated,
safe, auditable loop that runs on a schedule or continuously.

---

## Core design principles

### 1. The pipeline never trusts the AI
Every AI output is validated before it is accepted:
- Files the agent claims to have changed must actually exist inside the workspace
- Path traversal (`../../` tricks) is blocked
- The plan agent is prevented from writing any product files at all
- The coding agent's credentials are scrubbed from its environment

### 2. Failures are self-healing, not silent
- QA fail → ticket goes to `redo` with the exact failure attached to the next prompt
- After `maxAttempts` failures → ticket is `blocked` and a human is notified
- A missing or logged-out AI tool → provider goes on hold, ticket is restored; no attempt is counted

### 3. Knowledge compounds over time
Every redo requires the agent to write a `lesson.json`. The pipeline indexes all lessons and feeds
them to future runs. The AI stops repeating the same mistakes.

### 4. Zero external dependencies
The pipeline runs on Node.js 18.17+ with no npm packages. This means no supply-chain risk,
no `node_modules`, no version conflicts, and trivial installation (`npm link`).

### 5. Pluggable everywhere
- **AI agents**: Codex, Claude Code, Cursor, or any CLI that reads from stdin
- **Ticket trackers**: ClickUp (via REST API) or a local JSON file
- **VCS**: Git (branches + PRs), TFVC (custom command), or none (manual check-in)
- **QA**: Any command that exits 0 (pass), 2 (fail), 3 (environment blocked)

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CLI (cli.mjs)                         │
│  agent-pipeline init | doctor | run | loop | serve | ticket  │
└────────────────────────────┬────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Orchestrator   │  ← runOnce()
                    │ (orchestrator.mjs) │   One scheduler tick
                    └────────┬────────┘
              ┌──────────────┼──────────────┐
              │              │              │
       ┌──────▼──────┐ ┌─────▼─────┐ ┌───▼────┐
       │  Plan job   │ │  Code job │ │ Deploy │
       │ (planTick)  │ │(codeTick) │ │ batch  │
       └──────┬──────┘ └─────┬─────┘ └───┬────┘
              │              │            │
    ┌─────────▼──────────────▼────────────▼──────┐
    │              Adapters                        │
    │  agents/   trackers/   vcs/                  │
    │  codex     clickup     git                   │
    │  claude    file        command               │
    │  cursor                none                  │
    └─────────────────────────────────────────────┘
```

### Key files

| File | Purpose |
|---|---|
| `src/orchestrator.mjs` | The main pipeline loop: plan, code, verify, QA, check-in, deploy |
| `src/cli.mjs` | Command-line interface and `agent-pipeline serve` |
| `src/server.mjs` | Local web dashboard server (HTTP + SSE, zero deps) |
| `src/dashboard.html` | Browser dashboard UI (vanilla HTML/CSS/JS) |
| `src/prompt.mjs` | Builds the plan and code prompts from ticket + context + rules |
| `src/artifacts.mjs` | Validates agent handoff files (park.json, qa.json, lesson.json) |
| `src/config.mjs` | Config schema, defaults, deep-merge, validation |
| `src/docs.mjs` | Feature README management, keyword scoring, lesson indexing |
| `src/state.mjs` | Atomic JSON state store (one file per key in stateDir) |
| `src/lock.mjs` | File-based locking with heartbeat and stale-lock recovery |
| `src/exec.mjs` | Shell command runner with timeout, log streaming, streaming tail |
| `src/util.mjs` | Shared helpers: readJson, writeJson, redact, sanitize, render |
| `src/adapters/agents/index.mjs` | Agent presets (Codex, Claude, Cursor) + invocation builder |
| `src/adapters/trackers/clickup.mjs` | ClickUp REST API tracker |
| `src/adapters/trackers/file.mjs` | Local JSON file tracker (for demos and tests) |
| `src/adapters/vcs/git.mjs` | Git adapter (branch, commit, push, PR) |
| `src/adapters/vcs/command.mjs` | Custom command adapter (TFVC, etc.) |

---

## Ticket lifecycle

```
not started → [plan job]  → planning → code ready
                          → need info (question posted)
                          → needs approval (high-risk)

code ready  → [code job]  → in development → development completed (parked)
                          → [QA runs]      → ai test pass (checked in)
                          → [QA fails]     → redo (with failure evidence)
                          → [3 fails]      → blocked

ai test pass → [deploy batch] → sign off
```

All status names are configurable via `tracker.statuses` in `pipeline.config.json`.

---

## Handoff files (written by the AI agent)

| File | Required | Purpose |
|---|---|---|
| `park.json` | Always | Ticket ID, plain-English summary, list of changed files, limitations |
| `qa.json` | Always | Real test steps with assert lines; each step must cover an acceptance check |
| `plan.json` | Plan job only | Decision (clear/need-info/high-risk), acceptance checks, scope, files |
| `needinfo.json` | When blocked | One plain-English question before coding can proceed |
| `lesson.json` | On redo | Title, symptom, root cause, rule, keywords — filed in the memory index |

---

## Documentation structure (inside a user's project)

```
docs/
  FEATURES.md                      ← generated index of all features
  features/
    <feature-slug>/
      README.md                    ← how this feature works today (front matter: title, keywords, paths)
      CHANGELOG.md                 ← one line per checked-in ticket
      tickets/
        <ticket-id>.md             ← the plan for each ticket
  memory/
    INDEX.md                       ← index of all lessons
    lessons/
      <ticket-id>-<slug>.md        ← one lesson file per redo
```

---

## Configuration reference

The full schema with all defaults is in `src/config.mjs` (`DEFAULTS` object).
A minimal working example is in `templates/pipeline.config.example.json`.
An enterprise TFVC + ClickUp example is in `templates/examples/enterprise-tfvc.config.json`.

Key sections:

```jsonc
{
  "agent":   { "provider": "codex|claude|cursor|<custom>", "maxMinutes": 50 },
  "tracker": { "type": "file|clickup", "listId": "...", "statuses": { ... } },
  "vcs":     { "type": "none|git|command", ... },
  "gates":   { "build": "<command>", "unitTests": "<command>" },
  "qa":      { "command": "<command> {ticket}", "exitCodes": { "pass": 0, "fail": 2, "blocked": 3 } },
  "deploy":  { "command": "<command>", "batchMin": 10 },
  "docs":    { "featuresDir": "docs/features", ... },
  "plan":    { "enabled": true, "perTick": 2 }
}
```

---

## Roadmap (planned improvements)

- [ ] Additional tracker adapters: Jira, GitHub Issues, Linear, Azure DevOps
- [ ] Parallel ticket execution (Git worktrees)
- [ ] Webhook support (skip polling when tracker pushes events)
- [ ] Web dashboard (`agent-pipeline serve`) with real-time SSE updates
- [ ] Slack/email notifications on failure or deploy
- [ ] Per-feature agent model selection
- [ ] Plugin system for custom validation steps

---

## Non-goals

- This is **not** a replacement for your AI coding tool. It orchestrates it.
- This is **not** a ticket tracker. It integrates with yours.
- This is **not** a CI/CD system. It calls your build, test and deploy commands.
- This does **not** guarantee correct output. It guarantees the process is followed and failures are surfaced.
