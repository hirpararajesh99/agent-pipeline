# Project Brain architecture and design direction

Status: current foundations plus proposed design. See the
[vision](PROJECT-BRAIN.md) and [roadmap](ROADMAP.md).

## Current implementation

| Component | Responsibility today |
| --- | --- |
| `src/indexer.mjs` | File inventory, hashes, web references, direct impact, path-based context ranking |
| `src/brain.mjs` | Named runs, manual/automated stages, snapshot guard, evidence validation, synthesis and on-demand finding freshness |
| `src/brain-refresh.mjs` | Selective finding revisions, immutable base records, explicit acceptance and recoverable output journals |
| `src/brain-review.mjs` | Scoped developer decisions, conflicts, event history, ownership and review-context snapshots |
| `src/brain-lessons.mjs` | Lesson review/revision history, applicability, duplicate review, retirement and retrieval filtering |
| `src/indexers/index.mjs` | Built-in analyzer registry |
| `src/indexers/dotnet.mjs` | Heuristic .NET project, type, namespace, route, and DI relationships |
| `src/docs.mjs` | Feature documentation and lesson selection/indexing |
| `src/preflight.mjs` | Ticket completeness and risk hints before agent invocation |
| `src/prompt.mjs` | Includes selected feature, lesson, and index context |
| `src/orchestrator.mjs` | Builds context for plan/code and writes indexes during successful check-in flow |

The index is rebuilt from source; its hashes are not an incremental cache. Accepted
analysis findings have a separate on-demand SHA-256 freshness check. Static graph edges are navigation aids, not guaranteed
runtime dependencies. Current retrieval ranks file paths and feature paths, with
limits on selected files and edges; it has no measured token-budget enforcement.

## Proposed knowledge model

Use small Markdown documents for explanations, decisions, and developer review.
Use versioned JSON records for retrieval and validation. Do not require a graph
database or vector service for the first milestone; evolve storage only when measured
project size or retrieval quality requires it. Preserve the zero npm dependency rule.

A proposed finding record needs: stable ID, topic/module, statement, certainty,
evidence references, examined revision/hashes, verification method, freshness,
author/source, review state, related finding IDs, and supersession history.
Certainty and freshness are separate: a previously verified fact may now be stale.
Edges should identify their extraction method and evidence, and indicate whether
they are observed or inferred. Do not promote type-name matches into proven calls.

Developer decisions retain attribution and scope. Conflicting findings remain visible
until evidence or an authorized decision resolves them. Generated content must pass
schema, path, evidence-reference, and output-scope checks before it becomes accepted
knowledge. Missing evidence is an explicit gap rather than invented certainty.

## Storage and layout

The existing customer-project outputs remain `docs/project-index.json`,
`docs/project-graph.json`, `docs/PROJECT-INDEX.md`, `docs/features/`, and `docs/memory/`.
The documentation under `docs/product/` in this repository describes the product;
it is not generated knowledge about a customer repository.

Milestone 1 places each analysis in a named run. This preserves developer knowledge
and permits a fresh source snapshot without overwriting earlier accepted analysis:

```text
.project-brain/runs/<name>/
  state.json
  project-context.md
  knowledge/project.json
  prompts/01-...md through 08-...md
  submissions/01.json through 08.json
  ai-analysis/
    01-repository-overview.md
    02-architecture.md
    03-modules-and-flows.md
    04-business-rules.md
    05-data-and-integrations.md
    06-patterns-and-conventions.md
    07-legacy-risks.md
    08-validation.md
    final-context.md
  RUN-ANALYSIS.md
```

The run layout is fixed in this milestone. Existing feature docs and lessons remain
in place; the prompts instruct agents to inspect those sources. Existing
`.ai/project-context.md` is never overwritten. Future output path configuration or
migration needs a compatibility plan. The earlier `.agent/{core,tasks,rules,templates}` and
`Documentation/Product/<Feature>/` suggestions are alternate layouts to map through
configuration, not additional mandatory copies. AGENTS.md may point to knowledge;
it should not become the entire knowledgebase.

## Analysis lifecycle and future retrieval

Bootstrap records inventory, available analyzers, and coverage gaps. Ordered prompts
then guide an external agent through only the required topics/modules. Later stages
reuse accepted findings, and a synthesis links to their evidence and uncertainties.
Stage state records inputs, outputs, versions, and completion so work can resume.
Analysis uses SHA-256 snapshots and rejects results after covered application changes.
The snapshot spans the repository even for a module-scoped run. Exclusions, symlink
handling, and trusted state boundaries are listed in the feature guide. This detects
changes; it is not a sandbox for the external coding agent.

Submission schema version 1 carries a stage, scope, snapshot ID, summary, findings,
unknowns, and limitations. Findings carry certainty, verification method, and source
hashes/line ranges. Mechanical validation cannot prove the semantic truth of a claim.
Validated JSON is rendered by the pipeline; source paths in Markdown link back to
repository files. A pending-output journal and per-run lock protect ordered progress
through interrupted rendering. A deterministic synthesis assembles the eight summaries
and gaps rather than invoking another model. `brain init/status/analyze/freshness`
start no model process. `brain run` invokes the configured agent for each remaining
stage and accepts output only through the same submission validator.

`brain freshness` verifies run integrity independently of the acceptance snapshot
guard, then compares accepted evidence hashes against a new source scan. It returns
current/stale/unchecked per finding, preserving certainty, plus all source changes.
It does not mutate state, rewrite findings, or accept a new snapshot. Matching cited
bytes do not establish semantic validity; uncited changes and additions still need
review. Pending submissions are excluded. The existing strict snapshot guard remains
in place for accepting or resuming stages. Developer decisions and conflicts are
stored separately from agent findings as described below.

### Selective refresh (Milestone 2b)

A refresh is a separate named run with `kind: "refresh"` and schema version 1.
Original version-1 runs remain readable without migration or mutation. Preparing
it copies accepted effective findings into protected `knowledge/base.json`, records
their aggregate hash, selects stale or explicitly requested IDs, and captures a
new repository snapshot in `knowledge/project.json`. It generates a single focused
prompt and a submission contract; it does not start a model process.

Finding identity is its original stage-prefixed ID. Each record has a revision
identity containing the run and snapshot, with a predecessor revision and content
hash for a replacement or retirement. Accepted merged records live in
`knowledge/findings.json`; a readable view is `ai-analysis/refresh.md`. Unselected
records retain their original content and revision identity. Historical records
remain in base.json and earlier runs; retirement retains evidence and a reason.
Further refreshes use the previous accepted merged records as their base.

The explicit `brain refresh --accept` action validates exactly the selected IDs,
predecessor hashes, replacement evidence and unchanged new snapshot. It writes a
journal before rendering; retries verify input identity and recover output and
final-state rename failures. Source and target run locks serialize preparation;
the target lock serializes acceptance. Application files still need to be stable
during scans. State remains trusted local metadata, not tamper-proof storage.

Freshness reads inherited findings until acceptance and merged findings afterwards.
Retired records are listed separately. Original stage summaries are historical;
they are not promoted to fresh summaries. New finding discovery, automatic reviewer
identity and task context selection are separate work. The
usage guide documents the exact layout, limits, and recovery commands.

### Developer rationale and conflicts (Milestone 2c)

`.project-brain/review/records.json` stores a version-1 event ledger through the
atomic State writer. A project review lock serializes writes and refresh acceptance.
Events record sequence, UTC timestamp, caller-supplied author, type, ID, validated
payload, previous hash and event hash. Replay checks the chain and allowed state
transitions. This detects edited surviving records, not adversarial replacement,
deletion, truncation or recomputation of the entire trusted local ledger.

Decisions have scope, statement, rationale and optional pinned references. Replacing
one creates a new ID with a supersedes link; the prior record remains visible.
Conflicts preserve two positions, their reporter, owner, references and a history
of assignments, resolutions and reopening. Resolution may point to an active
decision applicable to the scope. Caller-supplied ownership checks are workflow
consistency, not authentication or authorization. Conflict discovery is manual.

New refreshes capture applicable active decisions and open conflicts in protected
`knowledge/review.json` and pin its hash. Scope overlap includes cited dependencies
outside the selected module. Acceptance holds the review lock, rejects open relevant
conflicts, and checks the captured context again, including on interrupted retries.
Unrelated scoped events do not invalidate the capture. Changed relevant context
requires a new target run. Accepted findings retain their captured developer context;
the project ledger remains independent and continues to accumulate history.

CLI knowledge/list/show commands expose the full relevant history; CLI status and
freshness include current applicable decisions and open conflicts. Initial analysis
prompts point to the ledger as context when available. Integration into ordinary
ticket planning/coding and budgeted context selection remains Milestone 3 work.

### Lesson lifecycle (Milestone 2d)

`.project-brain/lessons/records.json` holds version-1 hash-linked events with full
revisions, attribution and reasons. A lesson lock and atomic State writes preserve
history through failed renames. Original Markdown/index files remain unchanged.
Shared safe path validation rejects traversal and symlinks for storage and inputs.

Review pins original text, effective rule, scope, applicability and optional evidence
hashes. Correction creates a revision; retirement/duplicate review excludes guidance
without deleting it. Duplicate suggestions use word overlap and require human review.
Read-time freshness detects changed/deleted lesson/evidence files. Names and hashes
do not establish authentication or semantic correctness.

Keyword retrieval filters candidates before ranking. Prompts carry active applicable
effective guidance with review/freshness labels; original Markdown is historical.
Legacy unreviewed guidance remains eligible with verification required. Workspace
review records override worktree policy, with evidence checked against actual worktree
files. Saved prompts are not rewritten. See the [lesson guide](../features/project-brain/LESSONS.md).

Future retrieval will, for a ticket, select a small overview, matching feature docs, scoped decisions and
lessons, and nearby graph evidence. Report selection reasons and omitted context.
Check evidence freshness before using findings. Allow targeted source inspection
and bounded expansion when evidence is insufficient. Avoid injecting a full-project
synthesis into every task regardless of relevance.

After accepted changes, compare evidence fingerprints, flag affected findings, and
refresh only the necessary scope. Edits made outside Agent Pipeline must be detected
on the next freshness check as well. Preserve unrelated and human-maintained content.

## Extensibility and decisions still needed

Keep language extraction separate from shared knowledge, retrieval, and orchestration.
Expand .NET coverage with representative legacy and modern fixtures before declaring
broad support; dynamic dispatch, reflection, generated code, database calls, and
configuration-dependent behaviour need explicit coverage notes. Future Java, Python,
Node, and PHP analyzers should share an evidence format and compatibility tests.

Further work must settle authenticated review policy, context
budget defaults, and configurable path compatibility. Non-Git snapshots currently
use content hashes; Git HEAD is optional. Compiler-backed analysis can be evaluated
later without adding an implicit toolchain requirement to the core package.
