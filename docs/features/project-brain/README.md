---
feature: project-brain
title: Project Brain foundations
keywords: [project, brain, knowledge, index, graph, dotnet, context, lessons]
paths: [src/brain.mjs, src/indexer.mjs, src/indexers/, src/docs.mjs, src/prompt.mjs, src/orchestrator.mjs]
updated: 2026-10-06
---

# Project Brain: current capabilities

This describes the foundation and Milestone 1 implementation as of 2026-10-06. The full
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
| Freshness | File hashes exist, but findings do not yet have automatic stale/conflict tracking |

Guided prompts now support architecture, business rules, data/integrations, patterns,
risks, and validation analysis by an external agent. Deterministic scanning itself
does not infer those topics. Knowledge review, finding-level freshness, and a knowledge
browser remain planned. Java, Python, and PHP do not yet have dedicated analyzers;
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

These commands do not invoke an agent, build the application, or require credentials.
Existing configuration supplies the workspace and index settings. Without a config,
the current directory and default index settings are used. No .NET SDK is required
for regex-based analysis. Source hashes use SHA-256 in analysis runs; the existing
project index retains its original hash format.

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
journal that `brain analyze` resumes. For revised source, scope, or accepted findings,
start a new named run. Existing runs and `.ai/project-context.md` are preserved.
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

Synthesis is not automatically injected into normal ticket prompts in this milestone.
Developers can direct their agent to the generated context; automatic task selection
of the new findings belongs to the later retrieval milestone.

## Validation evidence

`test/brain.test.mjs` covers eight-stage legacy/modern .NET analysis, repeated init,
missing docs/history, interrupted rendering, invalid evidence, changed application
files, edited controls, symlinks, and standalone CLI usage. `test/pipeline.test.mjs`
covers the existing pipeline and index. All 41 tests pass. These fixtures establish those examples;
they are not certification for arbitrary legacy repositories. Run `npm test` in the
Agent Pipeline repository. Pilot criteria are defined in the roadmap.
