# Lesson lifecycle

Milestone 2d adds scoped applicability, corrections, duplicate review and retirement
to the existing Markdown/index workflow. Run these commands in the target project.
Use `--config` for a non-default configured lesson directory.

## Inspect and review

```sh
agent-pipeline brain lesson list
agent-pipeline brain lesson list --scope App
agent-pipeline brain lesson show --file docs/memory/lessons/20261027-T1-check-related-list.md
agent-pipeline brain lesson review --file docs/memory/lessons/20261027-T1-check-related-list.md --by Rajesh --reason "Checked save flow" --scope App --applicability "When saving widget lists" --evidence App/code.cs
```

Replace example paths with actual files from `list`. Legacy lessons are discovered
without migration and labelled **unreviewed**. Review requires attribution, reason
and applicability; the first review extracts the `## Rule` section. Scope defaults
to `.`; use canonical relative paths with `/` and exact casing, not globs.

Up to 50 comma-separated evidence files can be pinned by SHA-256. `list`/`show` check
current bytes on demand. Changed/deleted lesson or evidence files become **stale**;
matching evidence is **current**; no evidence is **unchecked**. These labels do not
prove semantic correctness. Unrelated edits do not invalidate the lesson.

## Correct and retire

```sh
agent-pipeline brain lesson correct --file docs/memory/lessons/20261027-T1-check-related-list.md --by Rajesh --reason "Rollback must not refresh the list" --rule "Refresh widgets only after commit"
agent-pipeline brain lesson retire --file docs/memory/lessons/20261027-T1-check-related-list.md --by Rajesh --reason "The old save flow was removed"
```

Review before correcting. Correction preserves all earlier revisions and source
snapshots. It may also update `--scope`, `--applicability` and `--evidence`; omitted
values inherit the last revision. Review/correction captures current input bytes,
so inspect them first. `--evidence ""` clears evidence in shells preserving empty
arguments; the JavaScript API accepts `evidence: []`.

Retirement excludes guidance without deleting it, even after a previously reviewed
source file is removed. Explicitly `review` again to reactivate retired, duplicate
or stale guidance. Later reviews preserve the effective rule: use `correct` to change
it, including after an external edit to the original Markdown Rule.

## Duplicate review

```sh
agent-pipeline brain lesson duplicates --scope App
agent-pipeline brain lesson duplicate --file docs/memory/lessons/20261027-T2-check-related-list.md --by Rajesh --reason "Same rule and conditions as T1" --duplicate-of docs/memory/lessons/20261027-T1-check-related-list.md
```

Suggestions require at least 80% rule-word overlap and overlapping scopes. They never
modify records and do not establish semantic equivalence. Compare conditions yourself.
The retained target must be active, reviewed, non-stale, distinct and overlap the
source scope. Its revision hash is pinned; both files and histories survive. Later
target correction/retirement does not automatically reactivate duplicates.

## Retrieval and compatibility

Memory-index entries and keyword ranking still identify candidates. `docs find` and
ticket prompts exclude retired, duplicate and stale reviewed lessons before ranking
and limits. Scoped lessons require overlap with selected feature paths, planned coding
paths or explicit path tokens in the ticket. Applicability prose requires judgment;
it is not an executable condition. Lessons absent from the index can be reviewed but
are not automatically added to retrieval.

Prompts carry effective guidance, scope, applicability, revision and freshness, and
identify original Markdown as historical. Legacy unreviewed lessons remain eligible
but explicitly require verification. In coding worktrees, configured-workspace review
records take precedence and evidence is checked against actual worktree files. Other
clones need the same records to share policy. New Brain prompts direct agents to check
lesson state; existing saved prompts are not rewritten.

## Persistence and limits

`.project-brain/lessons/records.json` stores versioned, hash-linked events with full
revisions, reviewer, reason and timestamp. A lock and atomic State write preserve
committed history through failed renames; retrying the latest identical action is a
no-op. Reads do not create empty state. Review commands never rewrite the original
Markdown or memory index. Invalid history and unsafe/symlinked paths fail closed,
including during context selection.

This is trusted local metadata, not signed auditing: filesystem access permits
replacement/deletion or recomputing hashes. Names are caller-supplied. CLI/prompt
display redacts common secret patterns, but stored snapshots preserve input; keep
secrets out of lessons. The feature does not train the model or guarantee fewer mistakes.

Limits: 1 MiB per lesson source, 8 MiB per evidence file, 16 MiB per history, and 500
lessons per duplicate comparison (narrow scope for larger reviews). Automatic archival,
semantic duplicate detection, authenticated review and budgeted context selection are
not implemented. [Milestone 3](../../product/ROADMAP.md#3-explainable-context-and-incremental-analysis)
is next.
