# Project Brain architecture and design direction

Status: current foundations plus proposed design. See the
[vision](PROJECT-BRAIN.md) and [roadmap](ROADMAP.md).

## Current implementation

| Component | Responsibility today |
| --- | --- |
| `src/indexer.mjs` | File inventory, hashes, web references, direct impact, path-based context ranking |
| `src/brain.mjs` | Named analysis runs, ordered prompts, snapshot guard, evidence validation, resumable rendering and synthesis |
| `src/indexers/index.mjs` | Built-in analyzer registry |
| `src/indexers/dotnet.mjs` | Heuristic .NET project, type, namespace, route, and DI relationships |
| `src/docs.mjs` | Feature documentation and lesson selection/indexing |
| `src/preflight.mjs` | Ticket completeness and risk hints before agent invocation |
| `src/prompt.mjs` | Includes selected feature, lesson, and index context |
| `src/orchestrator.mjs` | Builds context for plan/code and writes indexes during successful check-in flow |

The index is rebuilt from source; existing hashes are not yet an incremental cache
or a stale-finding detector. Static graph edges are navigation aids, not guaranteed
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
and gaps rather than invoking another model. No model process is started by brain commands.

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

Further work must settle review ownership, finding-level freshness/conflicts, context
budget defaults, and configurable path compatibility. Non-Git snapshots currently
use content hashes; Git HEAD is optional. Compiler-backed analysis can be evaluated
later without adding an implicit toolchain requirement to the core package.
