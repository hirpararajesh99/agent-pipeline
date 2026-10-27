# Project Brain feature history

## 2026-10-27 — Milestone 2d: lesson lifecycle; Milestone 2 complete

- Added lesson inspection/review, scoped applicability, evidence freshness, duplicate
  suggestions/review, corrections, retirement and preserved revision history.
- Original Markdown/index files remain intact; legacy lessons are labelled unreviewed.
- Ticket context excludes retired, duplicate and stale reviewed lessons; prompts use
  effective corrections. Workspace review policy applies to separate coding worktrees.
- Added 12 regression tests; full suite: 87 passing tests. Coverage includes history,
  filtering, atomic failures, unsafe paths, corrupt records, CLI/redaction and worktrees.
- All Milestone 2 steps are delivered; Milestone 3 context transparency/budgets is next.
  Real-provider, minimum-runtime and cross-platform release checks remain pending.

## 2026-10-27 — Milestone 2c: developer rationale and conflicts

- Added project-wide attributed scoped decisions, supersession and pinned references
  to accepted findings or existing decisions.
- Added explicit conflicts, ownership assignment, reasoned resolution/reopening,
  and atomic event history with sequence/hash validation.
- Added knowledge/list/show commands and relevant review context to CLI status/freshness.
- Refreshes capture developer context and reject acceptance when relevant conflicts
  remain open or context changes, including interrupted retries.
- Added 13 tests for history, references, transitions, atomicity, tampering, locks,
  symlinks, scope/dependency selection, refresh compatibility and CLI redaction.
- Attribution remains caller-supplied; no authentication or automatic conflict discovery.

## 2026-10-27 — Milestone 2b: selective refresh

- Added `brain refresh --name SOURCE --to NEW` to prepare focused review of stale
  findings, with `--findings` for explicit selections and smaller batches.
- Added explicit `brain refresh --name NEW --accept` for validated revisions and
  retirements; predecessor hashes, original records, and inherited revision identity
  preserve history across successive refreshes.
- Added recoverable preparation/acceptance journals, including final state rename
  failures, and extended status/freshness to understand refresh runs.
- Added 14 tests covering preservation, chains, retirement, batching, invalid inputs,
  source drift, tampering, recovery, locks, symlinks, and standalone CLI behavior.
- Step 2c (developer rationale and conflicts) is next; human review identity and
  conflict resolution are not part of this refresh implementation.

## 2026-10-27 — Milestone 2a: finding freshness

- Added `brain freshness --name NAME`: checks accepted evidence against current
  source, reports per-finding current/stale/unchecked states and all changed files.
- Kept certainty separate from freshness and preserved existing run files and
  snapshot acceptance rules. Added six regression tests for evidence changes,
  preservation, tampering, symlinks, and CLI behavior.
- Documented the existing automated `brain run` workflow and its provider requirements.
- Split remaining Milestone 2 work into selective refresh, decisions/conflicts,
  and lesson lifecycle; recorded release readiness separately.

## 2026-10-06 — Milestone 1 implemented

- Added standalone `brain init`, `brain status`, and `brain analyze` commands.
- Added module-scoped named runs, initial knowledge, eight prompts, and evidence-linked Markdown synthesis.
- Added source snapshots, submission validation, generated-file integrity checks,
  per-run locking, and interrupted-render recovery; existing developer docs are preserved.
- Added 14 tests covering legacy/modern .NET workflows and failure/recovery paths.
- Defined change-detection and human-review limits in the usage guide.

## 2026-10-06 — vision and delivery criteria documented

- Recorded the Project Brain brief, evidence/freshness requirements, developer
  rationale, conflict handling, incremental context, lesson review, and pilot metrics.
- Documented current capability limits and proposed analysis/layout decisions.
- Added a phased roadmap with acceptance criteria. No new runtime commands added.

## Foundation — commit ee691cf

- Added file/reference indexing, compact task context, direct impact lookup, and
  initial .NET heuristics alongside preflight and deletion-aware handoffs.
- Existing feature docs and lessons provide reusable context to the pipeline.
