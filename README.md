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
  CHECK-IN   only the existing files and deletions in park.json + docs the pipeline writes: ticket plan, README, CHANGELOG,
             lesson + index, feature index. Status "ai test pass".
  DEPLOY     after batchMin tickets: deploy + smoke command, status "sign off"
```

The plan job and the code job have separate locks, so you can run them from two schedules or together.

## Preflight: save agent time and tokens

Before the pipeline starts a plan or coding agent, it runs a deterministic, no-AI preflight. By default it
requires a title and a meaningful description, finds the matching feature documentation and earlier lessons,
and flags risk terms such as database, permissions, payments, deletion and secrets. An incomplete ticket is moved
to `need info` before an agent is started. Risk signals are included in the focused prompt for the human and the
plan agent to verify; they do not make an automatic product decision.

Configure it in `pipeline.config.json`:

```json
"preflight": {
  "enabled": true,
  "requireDescription": true,
  "minDescriptionChars": 20
}
```

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

The pipeline also builds a dependency-aware project index for HTML, CSS, JavaScript, manifests, local assets and .NET solutions/projects.
It gives each agent only the most relevant file paths and relationships before it explores code. Generate or inspect it with:

```
agent-pipeline docs scan
agent-pipeline docs impact assets/logo.png
```

The built-in .NET analyzer recognizes solution and project references, C# namespaces/types, legacy ASPX code-behind files,
and modern ASP.NET routes and dependency-injection registrations. The analyzer interface is extensible for future Node,
Python, Java and PHP project maps.

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

## Step-by-step: first project pilot

Use this process for the first ticket in every new project. Start with a small, low-risk change; do not make the
first ticket a database migration, authentication change, payment change, deletion of business data, or deployment.

### 1. Check prerequisites

Install Node.js 18.17 or newer and one supported coding agent (`codex`, `claude`, Cursor's `agent`, or a configured
custom command). Sign in to the coding agent once before using the pipeline.

From the agent-pipeline repository, run the test suite before sharing a new version:

```cmd
cd E:\agent-pipeline
npm.cmd test
```

On macOS/Linux, use `npm test`. The suite uses fake agents and requires no AI account or network access.

### 2. Make the target project safe

Commit the project or create a backup before the first run. Start with `vcs.type: "none"` only when working on a
copy of the project or when a person will inspect every changed file. Prefer Git worktrees after the pilot is proven.

### 3. Initialise the target project

From the target project root, use the source directly during development:

```cmd
cd E:\my-project
node E:\agent-pipeline\bin\pipeline.mjs init
```

After installing the npm package globally, the equivalent command is:

```cmd
agent-pipeline init
```

`init` creates `pipeline.config.json`, `AGENTS.md`, `CLAUDE.md`, `jobs/`, `docs/`, and a sample `tickets.json`.
The sample `DEMO-1` ticket is only an example; block it before working on real tickets:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs ticket set DEMO-1 blocked
```

### 4. Configure the project

Edit `pipeline.config.json`. At minimum, choose the coding provider and configure real build/test/QA commands for
the project. A safe first configuration looks like this:

```json
{
  "agent": {
    "provider": "codex",
    "maxMinutes": 30,
    "plan": { "maxMinutes": 15 }
  },
  "vcs": { "type": "none" },
  "gates": {
    "build": "",
    "unitTests": ""
  },
  "qa": {
    "command": "your-real-qa-command"
  },
  "deploy": { "command": "" }
}
```

`qa.command` is required. Do not use an always-successful command for normal work: it proves only that the pipeline
ran, not that the website/application works. For a static website, a useful first QA script checks required assets,
stale asset references, key pages, and—where possible—browser screenshots.

Check the configuration before starting work:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs doctor
```

Every required item should show `ok`.

### 5. Create a good ticket

Include what changes, where it appears, expected result, what must not change, and test data/accounts if relevant.
For example:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs ticket add --id WEB-1 --title "Replace approved website logo" --description "What: replace the current logo with assets/company-logo.png. Where: header, footer, social metadata, favicon and publish mirror. Expected result: the approved logo appears on desktop and mobile. Do not change: navigation, page layout, colours or page text."
```

The deterministic preflight stops clearly incomplete tickets before an AI agent is started, saving tokens and cost.

### 6. Plan before coding

First see what the pipeline would select:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs run --dry-run
```

Then create the plan:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs run --job plan
node E:\agent-pipeline\bin\pipeline.mjs ticket show WEB-1
```

Review the plan's scope, listed files, acceptance checks, risks and QA focus. No project code should change during
planning. A `need info` result means add a human answer as a ticket comment, then set the ticket to `resume`.
A `needs approval` result requires a person to set the ticket to `ready` before coding.

### 7. Run the coding stage and review the result

Only after the plan is acceptable:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs run --job code
node E:\agent-pipeline\bin\pipeline.mjs ticket show WEB-1
```

The pipeline validates the agent handoff, paths, acceptance-check QA coverage, feature documentation, build/unit-test
gates, and your QA command before check-in. Review the file diff and the actual application/website before accepting
the result.

### 8. Correct a ticket safely

Use the right status for the situation:

| Situation | Action |
| --- | --- |
| Requirement/scope changed | Add a ticket comment, then set `resume`; the plan agent creates a new plan version. |
| QA/tester found a defect | Add a ticket comment, then set `redo`; the coding agent receives the evidence and must write a lesson. |
| Agent deleted obsolete files | The agent lists them in `park.json` `deletedFiles`, not `files`. |
| Ticket is blocked after repeated failures | Inspect the current working tree, add the missing information/fix, then set `resume` to re-plan. |

Examples:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs ticket comment WEB-1 "Use the approved transparent PNG. Remove the duplicate header wordmark."
node E:\agent-pipeline\bin\pipeline.mjs ticket set WEB-1 resume
node E:\agent-pipeline\bin\pipeline.mjs run --job plan
```

### 9. Build and inspect project knowledge

Generate the deterministic project index and reference graph at any time:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs docs scan
node E:\agent-pipeline\bin\pipeline.mjs docs impact assets\company-logo.png
```

This writes `docs/project-index.json`, `docs/project-graph.json`, and `docs/PROJECT-INDEX.md`. The pipeline also
refreshes these files after a successful ticket. The plan/code agents receive only a compact, relevant subset of this
map, reducing repeated repository exploration and token use.

### 10. Use the dashboard and scheduling

Start the local dashboard from the target project folder:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs serve --port 3000
```

Open `http://localhost:3000`. Keep this command running while viewing live state. The current dashboard is an
operator view; use `ticket show` for the complete saved ticket/plan record.

For safe automation, automate planning first:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs loop --job plan --interval 15
```

After the project has proven reliable, run both planning and coding on a schedule:

```cmd
node E:\agent-pipeline\bin\pipeline.mjs loop --interval 15
```

Windows Task Scheduler, cron, systemd timers and launchd can run one `agent-pipeline run` tick on a schedule.
Locks make overlapping runs safe.

## Switching the AI tool

`"agent": { "provider": "codex" | "claude" | "cursor" | "<your own>" }`. Use a different tool or model for
planning: `"agent": { "plan": { "provider": "claude", "model": "..." } }`. Presets are in
`src/adapters/agents/index.mjs`; override any field under `agent.providers.<name>` (all jobs) or
`agent.plan.providers.<name>` (planning only). For Claude the planning job gets read-only tools by default.
**CLI flags change between versions: check each tool's `--help` and adjust the preset.**

## Safety built in

- Plan agent is read-only: the pipeline snapshots the project and blocks the ticket if any file changed.
- The agent never gets tracker or deploy credentials; questions go through `needinfo.json`.
- Only files and deletedFiles listed in park.json (plus pipeline-written docs) are checked in. Paths are validated.
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

- Tested with a fake agent, the file tracker and `vcs: none` (27 tests). **Not tested** against the real
  Codex, Cursor or Claude CLIs, ClickUp, git remotes or TFVC. Run `doctor`, `--dry-run`, then one small ticket.
- The README-updated check proves the file changed, not that the content is right. A person reviews docs.
- Matching a ticket to a feature is keyword scoring; vague tickets may match nothing. The plan agent then
  searches the code itself and picks the feature name.
- One coding ticket at a time (planning can run in parallel). Git worktrees would allow more later.
- Agents run with the access you give them. Use a dedicated machine, VM or container and tight sandbox settings.
- Unattended use of a consumer subscription login may be restricted by each vendor's terms.
