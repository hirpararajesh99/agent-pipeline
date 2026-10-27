# Project Brain delivery roadmap

Status (2026-10-27): foundation and Milestones 1–2 implemented, including finding
freshness, selective refresh, developer review history and lesson lifecycle.
Milestones 3–5 remain planned. Current
capabilities are tracked in the [feature README](../features/project-brain/README.md).
Product requirements live in the [vision](PROJECT-BRAIN.md).

## Foundation available

Agent Pipeline already provides ticket orchestration, plan/QA gates, feature docs,
lessons, preflight checks, a file/reference index, direct impact lookup, compact
path context, and initial heuristic .NET analysis. These are foundations rather
than a complete project-understanding system.

## 1. Bootstrap and guided analysis — implemented

`brain init`, `brain analyze`, and `brain status` now provide a prompt-first workflow
for an external agent, including module scope and resumable stages. `brain run`
automates remaining stages with the configured provider and the same validator.
`brain refresh` is covered in Milestone 2; `brain context` remains a future design candidate. Runtime implementation is in
`src/brain.mjs`; the [usage guide](../features/project-brain/README.md#guided-analysis-walkthrough)
explains JSON submissions, generated Markdown, and guard coverage.

Delivery evidence: `test/brain.test.mjs` covers both .NET fixture variants, eight-stage
completion, invalid outputs, snapshot changes, repeated initialization, interrupted
rendering, CLI usage, and automated eight-stage execution with a fake provider. This is fixture-based
validation; the real-project maintenance pilot remains Milestone 4.

Acceptance criteria:

- One documented entry point creates an inventory, initial context, stages 01–08,
  and execution instructions without overwriting existing developer knowledge.
- Outputs record evidence, uncertainty, scope, schema version, and examined inputs.
- Analysis resumes from completed stages; synthesis links to findings and gaps.
- Application files remain unchanged during analysis; unexpected edits are detected
  and surfaced, and invalid agent artifacts are rejected.
- Tests cover both legacy and modern .NET fixtures, missing docs/history, invalid
  evidence paths, interrupted stages, and repeated initialization.
- The implementation explicitly reports analyzer limitations and required tools.

## 2. Freshness, rationale, and conflicts — implemented

Deliver this milestone in these steps:

- [x] **2a. Inspect freshness:** `brain freshness --name NAME` reports accepted
  findings as current/stale/unchecked, preserves certainty and prior outputs, and
  detects source changes made inside or outside the pipeline. It works with existing
  runs. Tests cover deleted evidence, unrelated files, integrity checks, and CLI use.
- [x] **2b. Selective refresh:** `brain refresh --name SOURCE --to NEW` creates a
  review of stale findings, or selected IDs via `--findings`. `--name NEW --accept`
  validates revised/retired findings against new evidence. Immutable base records,
  per-finding revision/predecessor identity, unchanged inherited records, and all
  prior runs preserve history. Preparation and acceptance recover interrupted
  rendering and final-state writes. Tests cover revisions, retirement, batches,
  chaining, evidence rejection, snapshot drift, tampering, locks, symlinks, and CLI use.
- [x] **2c. Developer rationale and conflicts:** scoped attributed decisions with
  supersession, pinned finding/decision references, explicit two-position conflicts,
  ownership, resolution and reopening history. An atomic project-wide event ledger
  preserves prior records. New refreshes capture relevant review context and block
  acceptance on open conflicts or changed context. Tests cover persistence, invalid
  transitions, tampering, locking, recovery guards, scope filtering and CLI display.
  See the [review guide](../features/project-brain/REVIEW.md). Attribution is caller-supplied;
  authenticated identities and automatic conflict discovery are outside this step.
- [x] **2d. Lesson lifecycle:** scoped applicability, evidence freshness, duplicate
  suggestions/review, correction, retirement and preserved history. Retrieval uses
  effective rules and excludes retired, duplicate and stale reviewed lessons, including
  workspace policy in worktrees. Legacy lessons remain labelled unreviewed. See the
  [lesson guide](../features/project-brain/LESSONS.md) and `test/lessons.test.mjs`.

Step 2a compares cited file bytes only; it is not semantic revalidation or a live
monitor. Step 2b uses external analysis and an explicit acceptance command; it does
not authenticate reviewers or regenerate original stage summaries. All four steps
are delivered with local fixture coverage (87 passing tests); semantic truth,
real-provider validation and measured pilot outcomes remain outside this evidence.
See the [usage guide](../features/project-brain/README.md#finding-freshness-after-source-changes).

Acceptance criteria:

- A changed or deleted evidence source flags related findings for review; unrelated
  findings and human explanations survive refresh.
- External edits are detected as well as pipeline-produced edits.
- Developers can record attributed, scoped decisions and resolve disagreements
  without silently replacing historical findings.
- Verified, inferred, and unknown knowledge can each independently become stale.
- Lessons support scoped applicability, duplicate review, correction, and retirement.

## 3. Explainable context and incremental analysis

Acceptance criteria:

- A task context preview lists selected evidence, reasons, budget, omissions, and gaps.
- Retrieval can expand from a feature to relevant graph neighbours without loading
  the entire repository, and reports when configured limits truncate context.
- Unchanged analysis is reused; a repeated task does not require full AI analysis.
- Incomplete graphs allow further investigation rather than claiming no side effects.
- Agent prompts distinguish accepted decisions, inferred findings, and unresolved conflicts.

## 4. Prove the legacy .NET maintenance experience

Pilot with a developer unfamiliar with one representative .NET Framework module and
one modern .NET module. Use comparable tasks, the same agent/model settings where
possible, and record differences in project size and available tests.

Acceptance criteria:

- The developer can explain a module's entry points, flow, constraints, and validation
  gaps from evidence-linked context and current source.
- A scoped change passes the project's available checks and developer review.
- Record baseline versus assisted investigation time, input/output tokens when
  available, retries, context size, missed dependencies, and reviewer corrections.
- Report bootstrap cost separately from subsequent task cost; mark estimates clearly.
- Publish observed results and failures. Broader rollout requires useful repeat-task
  improvement without worse review/validation outcomes; no fixed savings claim yet.

## 5. Broader access and adoption

Current release assessment: early source-code developer preview; public beta gates
are not complete. See the [release readiness record](RELEASE-READINESS.md) for
verified checks, remaining blockers, and the order of external testing.

After the pilot, prioritize a knowledge browser and chat/task entry in the dashboard,
additional language analyzers, and tracker integrations such as Jira. Automated queues
should continue with eligible work while individual tickets await required decisions;
approval policy needs an auditable scope and must not be bypassed to keep automation running.

For external testing, prepare a versioned npm beta, clean-package installation checks,
accurate support coverage, and a short onboarding example. Gather feedback from a small
tester group before promising broad project support. Model routing, parallel execution,
and richer storage/search are later decisions driven by evidence from those pilots.

## Updating this roadmap

Mark a milestone delivered only when its criteria are demonstrated. Link its tests,
usage docs, and known gaps from the feature README and changelog. Keep proposed CLI
examples out of the runnable quick start until their implementation exists.
