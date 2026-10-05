# agent-pipeline v0.2

A tool-agnostic, cross-platform pipeline that lets an AI coding agent (Codex, Cursor, Claude Code, or any CLI
that takes a prompt) work through tickets **one at a time**: plan, code, verify, test, document, check in, deploy.
It is an enterprise-grade Agent-PC process, generalised. Node 18.17+ only, no npm dependencies, Windows/macOS/Linux.

## The whole flow

```
ticket (not started / resume)
  PLAN JOB   plan agent reads ticket + comments + feature docs + lessons, changes nothing
             -> clear        : status "code ready", plan saved (acceptance checks AC1, AC2 ...)
             -> need-info    : one plain-English question posted, status "need info"
             -> high-risk    : plan saved, status "needs approval" (a person approves)
ticket (code ready / redo)
  CODE JOB   pipeline picks ONE ticket (redo first), prepares the workspace, seeds the feature README
             coding agent gets: approved plan + feature README + lessons + human comments
             agent writes code, updates the feature README, writes park.json + qa.json (+ lesson.json on redo)
  VERIFY     pipeline checks: handoff valid, files inside the project, every AC covered by a QA step,
             README updated, build + unit tests pass   (fail -> redo with evidence; 3 fails -> blocked)
  QA         your QA command: exit 0 pass, 2 fail, 3 blocked
  CHECK-IN   only the files in park.json + docs the pipeline writes: ticket plan, README, CHANGELOG,
             lesson + index, feature index. Status "ai test pass".
  DEPLOY     after batchMin tickets: deploy + smoke command, status "sign off"
```

The plan job and the code job have separate locks, so you can run them from two schedules or together.

## How the agent knows the feature (no AI involved in this step)

Documentation lives in the project, next to the code (`docs/` by default):

| Path | Purpose | Written by |
| --- | --- | --- |
| `features/<feature>/README.md` | How the feature works today. The agent's starting point | Coding agent, every change |
| `features/<feature>/tickets/<id>.md` | The plan for each ticket | Pipeline, from plan.json |
| `features/<feature>/CHANGELOG.md` | One line per checked-in ticket | Pipeline |
| `memory/INDEX.md`, `memory/lessons/` | Mistakes found on redo | Agent writes lesson.json, pipeline files it |
| `FEATURES.md` | Index of all features | `agent-pipeline docs index` |

Each README starts with front matter (`title`, `keywords`, `paths`). Before every agent run the pipeline scores
every feature against the ticket text and comments (keywords, title, folder names, README wording) and tells the
agent which README, changelog, earlier ticket plans and lessons to read first. Check what it will find with:

```
agent-pipeline docs find "widget list needs a search box"
```

### Change or enhancement after a ticket is done

- A **new ticket for the same feature**: the pipeline matches it to the feature, so the plan agent reads the
  README (which already describes the finished behaviour), the CHANGELOG, earlier ticket plans and lessons.
- A **tester finds a defect**: set the ticket to `redo` and add a comment. The coding agent gets the comment,
  must fix it, and must write a lesson.
- **The scope changed**: add a comment and set `resume`. The plan agent re-plans (plan version 2) using the
  earlier plan and the new comments, then the ticket goes back to `code ready`.
- **No docs exist yet** (an existing project like Novva): the plan agent describes what the code does today
  (`currentBehaviour`) and the pipeline creates the first README from it. Nothing has to be written by hand first.

## Statuses and who moves them

| Status (default name) | Meaning | Moved by |
| --- | --- | --- |
| not started (`new`) | Waiting to be planned | Person creates ticket |
| planning | Plan agent working | Pipeline |
| need info | A question is waiting. Answer with `ticket comment`, then `ticket set <id> resume` | Pipeline -> person |
| needs approval (`approval`) | High-risk plan. `ticket set <id> ready` to approve | Pipeline -> person |
| code ready (`ready`) | Plan done, waiting for coding | Pipeline |
| in development | Coding agent working | Pipeline |
| development completed (`parked`) | Verified, waiting for QA | Pipeline |
| ai testing | QA running | Pipeline |
| ai test pass (`pass`) | Checked in, waiting for the deploy batch | Pipeline |
| sign off | Deployed and smoke-checked; testers verify | Pipeline |
| redo | QA failed, or a person sent it back | Pipeline or person |
| resume | A person answered or changed scope, re-plan | Person |
| blocked | 3 failed attempts or an environment problem. A developer looks, then sets `ready` or `resume` | Pipeline |

All names are configurable under `tracker.statuses`. For ClickUp, create these statuses in the list first.

## Setup on Windows (or any OS)

1. Install Node.js LTS from https://nodejs.org. Check `node --version` (18.17 or newer).
2. Install one AI tool and sign in once (`codex`, `claude` or Cursor's `agent`).
3. In this folder: `npm test` (23 tests, no AI needed), then `npm link` and open a new terminal.
4. In the project folder you want to automate (commit or back it up first):
   ```
   agent-pipeline init
   ```
   This creates `pipeline.config.json`, `AGENTS.md`, `CLAUDE.md`, `jobs/`, `docs/` and a sample `tickets.json`.
5. Edit `pipeline.config.json`: `agent.provider`, `gates.build`, `qa.command`, and `vcs` (`none` to start).
6. Add tickets: `agent-pipeline ticket add --title "..." --description "What / Where / Expected result / Do not change"`.
7. `agent-pipeline doctor` must show `ok` everywhere. Then:
   ```
   agent-pipeline run --dry-run        # what would it do?
   agent-pipeline run --job plan       # plan tickets
   agent-pipeline ticket show DEMO-1   # read the plan
   agent-pipeline run --job code       # build, verify, QA, check in
   agent-pipeline loop --interval 15   # keep going
   ```

Scheduling: cron / systemd timer / launchd / Windows Task Scheduler running `agent-pipeline run`, or leave
`loop` running. Locks make overlapping runs safe.

## Switching the AI tool

`"agent": { "provider": "codex" | "claude" | "cursor" | "<your own>" }`. Use a different tool or model for
planning: `"agent": { "plan": { "provider": "claude", "model": "..." } }`. Presets are in
`src/adapters/agents/index.mjs`; override any field under `agent.providers.<name>` (all jobs) or
`agent.plan.providers.<name>` (planning only). For Claude the planning job gets read-only tools by default.
**CLI flags change between versions: check each tool's `--help` and adjust the preset.**

## Safety built in

- Plan agent is read-only: the pipeline snapshots the project and blocks the ticket if any file changed.
- The agent never gets tracker or deploy credentials; questions go through `needinfo.json`.
- Only files listed in park.json (plus pipeline-written docs) are checked in. Paths are validated.
- Ticket text and comments are marked as data in the prompt; pipeline comments are tagged and never fed back.
- A missing or logged-out AI tool puts that tool on a 15-minute hold without using up an attempt.
- Quota hits hold only that provider; optional `agent.fallback`.
- Atomic state writes; corrupt state raises an error instead of resetting.

## Example: Enterprise setup with TFVC and ClickUp

Start from `templates/examples/enterprise-tfvc.config.json`: ClickUp filters, `tf.cmd` check-in, Playwright
QA, ADO batch deploy, and your existing `Documentation/Product/<Feature>/` folders as the docs location.
Existing READMEs have no front matter, so add `keywords:` to the ones you want matched reliably and check with
`docs find`.

## Known limits

- Tested with a fake agent, the file tracker and `vcs: none` (23 tests). **Not tested** against the real
  Codex, Cursor or Claude CLIs, ClickUp, git remotes or TFVC. Run `doctor`, `--dry-run`, then one small ticket.
- A ticket that only deletes files cannot be listed in park.json; check those in by hand.
- The README-updated check proves the file changed, not that the content is right. A person reviews docs.
- Matching a ticket to a feature is keyword scoring; vague tickets may match nothing. The plan agent then
  searches the code itself and picks the feature name.
- One coding ticket at a time (planning can run in parallel). Git worktrees would allow more later.
- Agents run with the access you give them. Use a dedicated machine, VM or container and tight sandbox settings.
- Unattended use of a consumer subscription login may be restricted by each vendor's terms.
