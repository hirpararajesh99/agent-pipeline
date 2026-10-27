# Developer decisions and conflict history

Milestone 2c provides a project-wide review history independent of analysis runs.
It keeps developer intent and rationale separate from agent findings and observed
source behavior. These commands run locally without an AI provider or tracker.

## Record a decision

Run from the target project (or use its pipeline config):

```sh
agent-pipeline brain decision add --id module-local --scope App --by Rajesh --statement "Keep the module in process" --reason "Preserve the transaction boundary"
agent-pipeline brain decision list --scope App
agent-pipeline brain decision show --id module-local
```

`--by` is required attribution, and `--reason` preserves the explanation. Scope
defaults to `.`. A scope is a canonical project-relative file/directory path, not a
glob: use `/` and the project's exact casing. Paths are compared literally; they
may describe a future or deleted module. Absolute paths and traversal are rejected.

Optionally reference accepted findings with `--findings onboarding:01-entry` (use
an actual run and finding ID). Multiple references use commas. Each reference pins
the accepted record, its revision, and its content hash; it does not claim the
evidence is still fresh. `--decisions ID,ID` references existing decisions. At most
50 references may be attached to a record.

Correct or replace an existing decision by using a **new ID** and `--supersedes`:

```sh
agent-pipeline brain decision add --id module-outbox --scope App --by Rajesh --statement "Introduce an outbox before splitting the module" --reason "New delivery requirements" --supersedes module-local
```

The old decision retains its author, statement, rationale and references, and is
marked superseded. The replacement must have the same scope and supersede an active
decision. There is no in-place edit/delete command. Repeating the same creation
with identical attribution and inputs is a no-op.

## Record and resolve a disagreement

Capture both positions and assign a review owner:

```sh
agent-pipeline brain conflict add --id boundary --scope App --by Reporter --owner Rajesh --summary "Architecture disagreement" --left "Code uses direct calls" --right "Design proposes a remote service" --decisions module-outbox
agent-pipeline brain conflict show --id boundary
```

Two distinct positions are required. `--owner` defaults to `--by`. Describe where
each position comes from in its text; optional finding/decision references preserve
the relevant accepted records. Conflict discovery is manual: the system does not
automatically determine which claims disagree or which side is correct.

The current owner can record a resolution and the reasoning:

```sh
agent-pipeline brain conflict resolve --id boundary --by Rajesh --resolution "Keep direct calls until the outbox is validated" --reason "Reviewed transaction and delivery constraints" --decision module-outbox
```

An optional resolution decision must be active and overlap the conflict's scope.
Resolution does not change source code or rewrite agent findings. Both positions
and the resolution remain in history. Superseding a linked decision does not
automatically reopen an old conflict; a developer should review that relationship.

To change ownership or reopen a resolved disagreement:

```sh
agent-pipeline brain conflict reopen --id boundary --by Reporter --reason "New evidence affects the earlier resolution"
agent-pipeline brain conflict assign --id boundary --by Rajesh --owner Reviewer --reason "Reviewer owns the subsystem"
```

Assignment applies only to an open conflict and must be attributed to its current
owner. Reopening is allowed for any named reporter and retains the current owner.
Every action is
recorded; repeating the latest identical transition is a no-op.

## View the project knowledge

```sh
agent-pipeline brain knowledge --scope App
agent-pipeline brain conflict list --scope App
agent-pipeline brain freshness --name onboarding
```

`brain knowledge` returns scoped decisions (including superseded ones), conflicts
(including resolved ones), open-conflict IDs, and event history. The CLI's status
and freshness results include active decisions and open conflicts relevant to the
run's scope and its cited dependency paths. A root scope covers the whole project.
Knowledge commands remain available after application source changes. Reading an
empty review history does not create records.

## How refreshes use this history

New refreshes capture relevant active decisions and open conflicts in the protected
`knowledge/review.json`. Selection uses the run scope plus active findings' evidence
paths, so a cited dependency outside the module can bring in relevant review records.
The prompt tells the agent to distinguish intended behavior from observed code.
Developer records are context, not commands or permission changes.

Acceptance holds the project review lock and requires:

- No open relevant conflicts.
- The captured developer review context still matches current records.
- The existing source, evidence, submission, and run-integrity checks to pass.

If a relevant decision changes or a conflict is resolved after preparation, prepare
a new target run so the agent reviews the updated context. Unrelated scoped changes
do not invalidate a module refresh. Interrupted acceptance performs these checks
again; it cannot skip newly recorded conflicts. Old prepared refreshes without a
review snapshot can accept only when no relevant decisions/conflicts exist.

Accepted refreshes retain their captured context and include developer decisions
in their readable output. The live history continues independently; reading a past
refresh does not establish that its captured decisions are still current. Use
`brain knowledge` or the CLI's freshness/status output for current review records.

Initial analysis prompts also point to the review history when present. Automatic
task-context selection and enforcement in ordinary plan/code ticket workflows remain
Milestone 3 work; this feature's acceptance gate applies to selective refreshes.

## Persistence and limits

History lives in `.project-brain/review/records.json`, outside all named runs.
The commands append timestamped events to the logical history, saving the entire
document through an atomic state write and a project-level lock. Replay validates
transitions, event sequence, and hash links; modified events and malformed JSON
cause an error rather than an empty-history fallback. A failed rename leaves the
previous history authoritative, and the command can be retried. Temporary files
from a failed write are not treated as committed events.

This is trusted local storage, not a signed audit service: a person with filesystem
access can replace/delete it or recompute hashes. `--by` and `--owner` are caller-supplied
names, not authenticated identities. Name matching prevents accidental ownership
mix-ups, but does not enforce access control. Keep secrets out of records; CLI text
is redacted on display, while the machine-readable history preserves entered data.

The current history limit is 16 MiB. Writes exceeding it fail before replacing the
previous history. Automated archiving, signed identities, automatic conflict detection,
and cross-workspace synchronization are not implemented. Symlinked storage paths
are rejected. Review records never modify application source or accepted analysis files.
