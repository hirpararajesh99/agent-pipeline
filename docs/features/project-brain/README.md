---
feature: project-brain
title: Project Brain foundations
keywords: [project, brain, knowledge, index, graph, dotnet, context, lessons]
paths: [src/brain.mjs, src/brain-refresh.mjs, src/brain-review.mjs, src/brain-lessons.mjs, src/indexer.mjs, src/indexers/, src/docs.mjs, src/prompt.mjs, src/orchestrator.mjs]
updated: 2026-10-27
---

# Project Brain: current capabilities

This describes the foundation and completed Milestones 1–2: freshness, selective
refresh, developer review history and lesson lifecycle
as of 2026-10-27. The full
[vision](../../product/PROJECT-BRAIN.md), [architecture](../../product/ARCHITECTURE.md),
and [roadmap](../../product/ROADMAP.md) contain planned work.

## Use today

After initializing and configuring a target project (see the root
[README](../../../README.md)), run these commands from that project:

```sh
agent-pipeline docs scan
agent-pipeline docs impact assets/sidheshwar-logo.png
agent-pipeline docs find "website branding"
```

Replace the example asset path or search text with a real file/topic in your project.
Without npm link, invoke the same arguments with
`node E:\agent-pipeline\bin\pipeline.mjs` on Windows.

`docs scan` writes the file inventory, relationship graph, and Markdown inventory to
`docs/project-index.json`, `docs/project-graph.json`, and `docs/PROJECT-INDEX.md` by
default. `docs impact` reports direct indexed relationships, not transitive impact
or every runtime dependency. `docs find` selects feature docs and lessons; it does
not run a deep repository analysis. These commands do not invoke a coding agent.

Plan and code prompts receive compact index context alongside feature docs and
lessons. The check-in flow writes refreshed index artifacts after successful checks
when knowledge is enabled. Configure paths, ignore names, enabled adapters, and
context file/edge limits in `knowledge` in `pipeline.config.json`.

## Coverage and limitations

| Area | Implemented behaviour and limits |
| --- | --- |
| File inventory | Paths, kinds, sizes, hashes; rebuilds from disk rather than incremental reuse |
| Web relationships | Selected HTML/CSS/JS/TS/manifest references; no complete module resolver or runtime analysis |
| .NET | Solution/project references, code-behind, C# namespaces/types, selected routes and DI patterns |
| .NET precision | Regex/name-based evidence; type matches can be ambiguous, reflection and dynamic flows are not resolved |
| Context | Keyword/path ranking and file/edge count limits; no semantic ranking or measured token budget |
| Feature knowledge | Feature READMEs, plans, changelogs, and lessons reused by the pipeline |
| Learning | Lesson retrieval supplies context; no model training or guarantee of reduced mistakes |
| Lesson lifecycle | [Scoped applicability, review, freshness, correction, duplicate review and retirement](LESSONS.md); effective rules in prompts and preserved history |
| Freshness | `brain freshness` compares each accepted finding's cited file hashes on demand; CLI output also includes relevant review context |
| Selective refresh | `brain refresh` prepares a named revision run and explicitly accepts reviewed updates; prior knowledge is retained |
| Developer review | Scoped attributed decisions, explicit conflicts, ownership and resolution/reopening history; names are not authenticated |

Guided prompts now support architecture, business rules, data/integrations, patterns,
risks, and validation analysis by an external agent. Deterministic scanning itself
does not infer those topics. Decisions and conflicts are recorded explicitly through
the [review commands](REVIEW.md). A knowledge browser and automatic conflict discovery
remain unimplemented. Java, Python, and PHP do not yet have dedicated analyzers;
JavaScript reference extraction is not full Node application understanding. Token or
time savings have not been measured.

## Guided analysis walkthrough

1. Open a terminal in the target repository. Run `agent-pipeline brain init --name onboarding --scope .`.
   Substitute a real module directory or file for `.` to narrow the analysis. Run names
   use lowercase letters, digits, hyphens, or underscores (up to 48 characters).
2. Open `.project-brain/runs/onboarding/RUN-ANALYSIS.md`. The run contains an initial
   context, full repository hashes, selected scope, reference graph, coverage limits,
   and eight numbered prompts. Git HEAD is included when available; hashes work without Git.
3. Run `agent-pipeline brain status --name onboarding`. Give the reported prompt to
   an external coding agent. It should inspect source and earlier accepted findings,
   then write only the reported `submissions/01.json` (or the next numbered submission).
4. Run `agent-pipeline brain analyze --name onboarding`. It accepts one valid next
   stage and generates Markdown under `ai-analysis/`. An absent submission simply
   returns the next prompt. Invalid JSON or evidence returns an error and leaves the
   stage unaccepted, so the agent can correct that submission and try again.
5. Repeat stages 01–08: overview, architecture, modules/flows, business rules,
   data/integrations, patterns, risks, validation. Later prompts reuse accepted findings.
6. Read `ai-analysis/final-context.md` after stage 08. It assembles stage summaries,
   links to detailed findings and source evidence, and lists unknowns and limitations.
   Review this context and current code before using it for a future change.

The manual `init/status/analyze` commands do not invoke an agent, build the application, or require credentials.
Existing configuration supplies the workspace and index settings. Without a config,
the current directory and default index settings are used. No .NET SDK is required
for regex-based analysis. Source hashes use SHA-256 in analysis runs; the existing
project index retains its original hash format.

### Automated analysis

After `brain init`, `agent-pipeline brain run --name onboarding` invokes the configured
provider for each remaining stage and passes every submission through the same
validator. It requires the provider CLI and authentication; provider charges may apply.
Settings under `agent.brain` override the main `agent` settings; the standalone default
is Codex. Failures stop the run. Retrying preserves accepted stages, although an
unaccepted stage can invoke the provider again. Source changes still block acceptance.
Provider permissions, not the snapshot guard, control what the agent can execute.

### Finding freshness after source changes

Run `agent-pipeline brain freshness --name onboarding` from the target project.
Unlike `brain status`, this command permits changed source while still checking
generated controls and accepted submissions for tampering. It prints a JSON report
without updating analysis, submissions, prompts, or state. It uses the per-run lock
and invokes no AI. Existing schema-version-1 runs work without migration.

| Finding freshness | Meaning |
| --- | --- |
| `current` | All cited file hashes match the accepted evidence |
| `stale` | At least one cited file changed, disappeared, or became a symlink |
| `unchecked` | The finding has no evidence to compare |

Certainty (`verified`, `inferred`, `unknown`) is preserved separately. An unknown
finding with evidence can be current or stale; no-evidence findings remain unchecked.
The report contains `counts`, individual `findings` with evidence statuses, all
repository `changes` (added/modified/deleted), and original/current snapshot IDs.
`analysisStatus` describes stage completion, not whether knowledge is safe to reuse.
No accepted findings produces zero counts; it does not certify the project.

File-level hashes deliberately flag any edit to a cited file, even outside cited
lines. Added files, uncited dependencies, and changed behavior can invalidate a claim
without changing its cited bytes; review the change list and verify current code.
Summaries and free-text unknowns outside finding records are not assessed. Only
accepted stages are included; pending/unaccepted submissions are excluded.

External edits and pipeline edits are detected identically on the next invocation.
Checks use the snapshot exclusions below and do not follow symlink targets. The
scan is not atomic or continuous: use it while application files are stable. It
does not advance the accepted snapshot, regenerate findings, or relax the existing
acceptance guard. Selective refresh creates a separate run with new evidence and
captures the relevant [developer decisions and conflicts](REVIEW.md).

### Selective refresh and revision history

Prepare a refresh after source changes:

```sh
agent-pipeline brain refresh --name onboarding --to onboarding-r2
agent-pipeline brain status --name onboarding-r2
```

The source may be an initial analysis with accepted stages or a completed refresh.
An unfinished initial analysis contributes only its accepted findings; a pending
transaction or unaccepted refresh cannot be used as a source. No source run is modified.
By default all stale active findings are selected. `--findings ID,ID` selects only
the listed active IDs, including current or unchecked findings. Use it for uncited
changes or smaller batches. If nothing is selected, the command explains why and
does not create an analysis. New finding IDs require a new full analysis.

The new run uses this layout:

```text
.project-brain/runs/onboarding-r2/
  state.json
  knowledge/base.json        immutable prior records and selected targets
  knowledge/project.json     new snapshot and evidence hashes
  knowledge/review.json      captured developer decisions and open conflicts
  prompts/refresh.md          focused analysis instructions and submission example
  submissions/refresh.json    external agent's proposal
  knowledge/findings.json     merged records after acceptance
  ai-analysis/refresh.md      readable merged findings after acceptance
  RUN-ANALYSIS.md
```

Give `prompts/refresh.md` to an external coding agent. It may write only the reported
submission. Each selected ID needs exactly one operation with its `previousHash`
from `base.json`, a reason, and either:

- `action: "revise"` with a complete replacement `finding` using the same ID,
  certainty, verification explanation, and current evidence. Verified/inferred
  claims need evidence; unknown findings may have none.
- `action: "retire"` without a replacement finding, explaining why the old claim
  should no longer be used. Retirement preserves the old statement and evidence.

The envelope contains `schemaVersion: 1`, `kind: "refresh"`, the new `snapshotId`,
`baseHash`, `summary`, `revisions`, `unknowns`, and `limitations`. The generated
prompt has a complete example. Submissions have the same 2 MiB limit and source
evidence checks as initial analysis. Use batches for large sets.

Review the proposal and run:

```sh
agent-pipeline brain refresh --name onboarding-r2 --accept
agent-pipeline brain freshness --name onboarding-r2
```

Acceptance rejects missing/duplicate/unselected IDs, wrong predecessor hashes,
invalid evidence, modified controls, and changes to application files after
preparation. It writes the merged JSON and Markdown through a recoverable journal.
Unselected records preserve their content and revision identity. New revisions
record their run, snapshot, predecessor revision/hash, and reason. `base.json`
preserves the complete prior records, and all earlier runs remain available.
For another refresh, use `--name onboarding-r2 --to onboarding-r3`.

`brain freshness` uses accepted merged findings after acceptance. Before acceptance,
it checks the inherited base findings; proposals are never treated as accepted.
Retired findings are reported separately and excluded from active freshness counts.
An accepted batch can still contain stale findings that were not selected. File
changes are relative to that run's snapshot, while each finding keeps its own
evidence hashes. `brain status` describes workflow completion, not semantic validity.

Preparation and acceptance invoke no AI. `brain analyze` and `brain run` reject
refresh runs to require the separate `--accept` action. This is an explicit local
acceptance step, not authenticated human-review enforcement; keep execution
permissions under your control. Step 2c records caller-supplied decision authors and
conflict owners; it does not authenticate the person running the acceptance command.
Acceptance also requires no open relevant conflicts and unchanged captured review
context; see [the review guide](REVIEW.md#how-refreshes-use-this-history).
Original stage summaries, scope, and developer-maintained documents are not rewritten.

Repeat the original prepare command to recover interrupted preparation, or repeat
`--accept` to recover interrupted acceptance. Retries verify the source snapshot,
controls, submission bytes, and journal before continuing, including recovery from
a failed final state rename. If source changes after preparation, choose another
target run. If the very first state write failed before a journal was persisted,
use a new target name rather than overwriting orphaned files. Do not edit state or
accepted outputs. An unaccepted submission can be corrected unless acceptance was
already interrupted; then restore its exact bytes or prepare a new target.

### Output contract and resume behaviour

Each generated prompt includes an example JSON submission with `schemaVersion`,
`stage`, `snapshotId`, `scope`, `summary`, `findings`, `unknowns`, and `limitations`.
Each finding records an ID, statement, certainty, verification explanation, and evidence.
Evidence must reference a file in the snapshot with a matching SHA-256 hash and valid
line range. Verified/inferred findings require evidence; unknown findings may lack it.
An empty findings list must explain the gap in `unknowns`. Each submission is capped
at 2 MiB; referenced evidence text at 1 MiB per file.

The validator checks structure, source identity, and line bounds. It cannot establish
that a statement follows logically from cited code. Certainty labels remain agent
claims until reviewed. Missing docs/history and unavailable toolchains must be stated
as gaps; no stage should invent findings merely to complete the sequence.

`brain init` with the same name is idempotent and preserves progress. `brain status`
verifies the run and identifies the next prompt. Accepted submissions and generated
controls are fingerprinted; editing them is rejected. An interrupted render has a
journal that `brain analyze` resumes. For revised accepted findings, use selective
refresh; for a changed scope or new findings, start a full named run. Existing runs
and `.ai/project-context.md` are preserved.
If bootstrap itself is interrupted before state is written, use a new run name;
partially generated files are deliberately not overwritten.

### Guard boundaries

Application snapshots cover files across the repository, including outside the selected
module and files under `bin`. Added, modified, and deleted files block acceptance.
Unexpected files inside the active run are rejected. Symlink/junction output or evidence
paths are refused; symlink targets are not scanned. No developer changes are reverted.

Snapshots exclude root `.project-brain` and directory names `.git`, `node_modules`,
`.vs`, `.idea`, `obj`, `.pipeline`, and `.pipeline-state`. The active run's generated
files receive separate checks. Other runs, excluded directories, empty-directory
changes, and outside-repository changes are not guarded. State is trusted local
pipeline metadata, not protected storage against a malicious agent. Detection sees
the net changes at validation time and cannot detect an edit that was already reverted.
Use the external agent's own restricted tools if execution isolation is required.

Do not run application editing/build jobs concurrently with analysis. Prompts prohibit
source edits, mutating commands, and inclusion of secrets. JSON submissions are written
by the external agent; review them before sharing. Generated Markdown uses the existing
best-effort redactor, which is not a secret detector. Initial scanning and each snapshot
check read repository files; incremental scanning and token budgeting are later milestones.
Freshness uses the same source coverage, but reports changes instead of rejecting them.

Synthesis is not automatically injected into normal ticket prompts in this milestone.
Developers can direct their agent to the generated context; automatic task selection
of the new findings belongs to the later retrieval milestone.

## Validation evidence

`test/brain.test.mjs` covers eight-stage legacy/modern .NET analysis, repeated init,
missing docs/history, interrupted rendering, invalid evidence, changed application
files, edited controls, symlinks, and standalone CLI usage. `test/pipeline.test.mjs`
covers the existing pipeline and index. Freshness tests cover all certainty labels,
changed/deleted evidence, uncited additions, unchanged findings, exact preservation
of run files, tamper/lock checks, symlinks, and standalone CLI use. The automated
`brain run` test completes all eight stages with a fake provider. These fixtures establish those examples;
they are not certification for arbitrary legacy repositories. Run `npm test` in the
Agent Pipeline repository. The 2026-10-27 Windows run passed all 87 tests on Node
24.22.1. Selective refresh adds regression coverage for unchanged record/history
preservation, chained revisions, retirement, explicit batches, invalid evidence,
snapshot drift, tampering, locks, symlinks, CLI acceptance, and interrupted preparation
and acceptance (including final state writes). Review-history tests cover attribution,
supersession, references, conflict transitions, atomic writes, tampering, locks,
symlinks, scoped refresh guards, legacy compatibility and CLI display/redaction.
Lesson tests cover applicability, correction/history, external edits, retirement,
duplicates, atomic failures, locks, symlinks, CLI/redaction, effective prompt guidance
and workspace policy with worktree evidence.
Other platforms and the declared Node 18.17 minimum still need release
validation. Pilot criteria are defined in the roadmap.
