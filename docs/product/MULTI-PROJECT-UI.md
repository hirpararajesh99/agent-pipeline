# Local multi-project UI direction

Status: implementation started. `agent-pipeline workspace` provides a preliminary
local project registry, guided setup and agent selection, basic Brain and review
controls, and ticket/pipeline controls. It is
not yet the complete interface described below. The existing `serve` dashboard
remains a local, single-project pipeline operator view. This document describes a path to a local
application where people can manage multiple projects and complete supported
workflows through the UI, without requiring a hosted SaaS service.

## Goals and boundaries

- Register existing project folders, switch between them, and see their independent
  configuration, activity, and knowledge. Registering a folder must not initialize,
  overwrite, or alter it.
- Guide users from setup and analysis through ticket planning, approval, execution,
  QA, and review. Keep existing CLI workflows available.
- Preserve each project's tracker, state, locks, artifacts, and Brain runs. The
  project registry contains only local application metadata and paths.
- Start with the current built-in Node.js stack and no npm dependencies. This is a
  local application, not a multi-tenant hosted service.
- Make unavailable capabilities and incomplete setup explicit. A dashboard must not
  claim a project is healthy when a tracker or freshness check cannot be read.

## Navigation and screens

```text
Projects                         Current project: Billing     [Switch project]
  All projects                   Overview                     [Run pipeline]
  + Add project                  Needs attention  |  Active work  |  Knowledge
                                 Tickets needing review       Recent activity
Project navigation               Setup checklist              [View all]
  Overview
  Project Brain                  Brain / Tickets / Activity / Settings
  Tickets                        open detailed project-specific views
  Activity
  Settings
```

| Screen | First useful content and actions |
| --- | --- |
| All projects | Name, local path, setup status, recent activity, open project, add project; show unavailable folders and config errors. |
| Add project | Enter a local folder path and display name; inspect existing configuration; register without editing files. Offer a separate, explicit setup action if initialization is needed. |
| Overview | Current work, failures, approvals, provider holds, setup issues, recent activity, and Brain freshness when known. Link each item to its details. |
| Project Brain | List analysis runs; initialize a named run with a scope; show stage progress, findings, evidence, certainty, freshness, and limitations. Support manual and configured-provider analysis. |
| Brain review | Prepare and review selective refreshes; record and inspect decisions, conflicts, lessons, history, and applicable scope. Show unresolved conflicts before accepting a refresh. |
| Tickets | List supported tracker statuses; open ticket details, plan, acceptance checks, comments, failures, QA information, and actions. Allow ticket creation where the tracker supports it. |
| Ticket context | Show saved plan/code manifests with selected sources, scores, budget, omissions, and gaps. Label the estimate and distinguish a saved run's selection from a future preview. |
| Activity | Show project-scoped runs, events, failures, and available logs with clear loading, unavailable, and empty states. |
| Settings | Edit and validate project configuration, check setup, and identify missing tools or credentials without exposing secret values. Show command execution implications. |

On narrow screens, collapse navigation and let detail panels stack. Use keyboard
navigation, visible focus, labels, and text in addition to color for status.

## Core workflows

1. **Register and prepare:** Enter a local path, inspect the directory and existing
   configuration, register it, and open its overview. If setup is missing, explain
   what initialization creates and provide an explicit action. Existing files must
   be preserved; never silently create a runnable sample ticket.
2. **Understand the project:** Start a named Brain run with a selected scope. Show
   the generated stages and a manual path for an existing external agent, or allow
   the configured provider to run analysis. Present evidence, unknowns, and
   freshness separately from certainty. Existing validation still governs acceptance.
3. **Keep knowledge current:** Check freshness, review changed evidence, prepare a
   new selective refresh, inspect its submission and relevant decisions/conflicts,
   then explicitly accept it. Preserve history and explain why acceptance is blocked.
4. **Deliver a ticket:** Create a file-tracker ticket or use the connected tracker's
   supported workflow. Plan a scheduler tick, inspect the resulting plan and context,
   answer questions or approve when required, run coding, and examine QA and failures.
   Explain that a tick may choose another eligible ticket; do not imply ticket-specific
   execution unless a new capability actually guarantees it.
5. **Recover:** Surface missing provider, invalid configuration, lock, tracker, QA,
   and interrupted-work errors with actionable details. A status indicator must
   distinguish unknown data from success, and background jobs must retain their
   project identity if the user switches screens.

## Existing capabilities and gaps

| Capability | Available now | Work needed for the UI |
| --- | --- | --- |
| Project selection | `serve` loads one config and `createServer` captures it. | Registry, registration validation, per-project config resolution, scoped routing and lifecycle. |
| Live pipeline status | `GET /api/state` and `GET /api/events` return one project's snapshot; queue contains ready/redo tickets. | Isolate event subscribers and polling by project; show tracker failures and broader status coverage. |
| Pipeline actions | `POST /api/run`, `/api/pause`, `/api/unpause`, `/api/approve/:id`, and `/api/set-status/:id`. | Project-scoped validation, reliable job state and error responses, and clear action semantics. |
| Ticket details | `GET /api/ticket/:id` returns tracker details, comments, plans and failures. | Full list, creation where supported, commenting, QA/artifact views, and saved context manifests. File-tracker creation is currently a CLI-specific path; ClickUp creation is not implemented. |
| Brain workflows | Brain, refresh, review, and lesson operations exist in library modules and are exposed through the CLI. | Project-scoped APIs, run discovery, long-running job progress, review screens, safe evidence access, and error handling. |
| Setup and configuration | `init`, `doctor`, and synchronous configuration loading exist in the CLI. | Extract reusable structured setup/check services; validated configuration forms and non-destructive initialization. `doctor` currently prints results and sets process exit status. |
| Context selection | Plan/code runs save a budget selection manifest. | Read saved manifests safely; a pre-run preview and provider-exact token usage are not implemented. |

## Architecture and security requirements

- Use opaque project IDs in routes such as `/api/projects/:projectId/...`; resolve
  IDs through the registry rather than trusting a path supplied on each request.
  Normalize and validate registered paths, detect duplicate directories, and handle
  missing or moved folders without redirecting operations to another project.
- Load configuration relative to the selected project and preserve synchronous
  `loadConfig`/`buildConfig`. Do not use a process-wide current-directory change
  to switch projects. Verify distinct projects cannot accidentally share state,
  locks, or tracker files; report explicit configuration collisions.
- Use atomic writes for registry and state data; store registry metadata outside
  project content and never store credentials in it. Allow a configurable registry
  location for tests and portable installations. Removing a registration removes
  only the registry entry, not project files.
- Make background jobs and SSE subscriptions explicitly project-scoped. Existing
  module-level dashboard subscribers are shared; replace that design before
  broadcasting multiple projects. Maintain existing per-project locks and define
  what happens when a project is removed while a job is active.
- Bind to loopback. Before adding project selection or further write actions,
  address the existing wildcard CORS and missing origin/authentication protections.
  Validate host/origin, protect state-changing requests against cross-site requests,
  limit request bodies, and avoid rendering untrusted content as executable markup.
  Local access is still powerful: configured agents and commands can modify files
  and invoke external services.
- Reuse existing validators, redaction, adapters, and Brain acceptance logic. Treat
  tracker content and agent output as untrusted. Limit file access to approved
  project paths, protect against traversal and symlink escapes, and avoid sending
  secrets in API responses, logs, events, or settings forms.
- Do not silently change the semantics of existing `serve` users. Provide a migration
  path and regression coverage for the current single-project configuration.

## Proposed delivery and acceptance

1. **Foundation and onboarding:** local registry, isolated project selection,
   non-destructive registration, setup diagnostics, scoped overview, secure local
   request handling, and existing dashboard compatibility. Verify two projects with
   distinct configs and state, invalid/missing paths, switching, cross-project event
   isolation, and origin/request validation.
2. **Brain workspace:** run discovery, analysis status and findings, evidence and
   freshness, manual/provider workflows, selective refresh and review histories.
   Verify rejected submissions, stale evidence, conflicts, and interrupted recovery.
3. **Ticket workflow:** supported tracker listing, file-ticket creation, comments,
   plan/approval, run results, QA, and saved context selection. Verify real adapter
   limitations and avoid presenting scheduler ticks as ticket-specific execution.
4. **Settings and operational completeness:** validated configuration, integration
   diagnostics, logs and recovery. Walk through all supported normal workflows from
   a clean installation without CLI steps, including errors and unavailable tools.

For each phase run the full offline suite and add focused automated tests for new
server boundaries. Perform a browser walkthrough for empty, loading, error, and
populated states. Real-provider and real-tracker validation remain separate from
offline tests; do not claim measured token savings without a comparable pilot.
