# Changelog

All notable changes to `agent-pipeline` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- Completed Milestone 2 with lesson review, applicability, freshness, duplicate review, correction and retirement; effective guidance and workspace-aware filtering in ticket prompts
- Developer decision/conflict CLI commands, preserved project-wide review history, and scoped review-context checks during refresh acceptance
- `brain refresh`: focused finding revision/retirement in a new named run, explicit acceptance, preserved history, batch selection, and interrupted-write recovery
- `brain freshness --name NAME`: on-demand per-finding evidence checks that preserve accepted analysis and report changed, deleted, and uncited source files
- Documented automated `brain run`, remaining Milestone 2 steps, and developer-preview release readiness
- Project Brain Milestone 1: standalone `brain init/status/analyze`, module-scoped named runs, eight external-agent prompts, validated evidence-linked findings, snapshot change detection, resumable stage rendering, and final context synthesis (14 new tests)
- Project Brain vision, architecture direction, phased roadmap and acceptance criteria, plus current-capability documentation distinguishing implemented foundations from planned analysis and freshness features
- Project Knowledge Engine: deterministic HTML/CSS/JS/manifest/asset index, local-reference graph, impact lookup, compact file context in agent prompts, and initial legacy/modern .NET analysis
- `park.json` `deletedFiles` support: safely validates intentional deletions, supports deletion-only tickets, and stages Git deletions during check-in
- Deterministic preflight before plan and code runs: blocks clearly incomplete tickets without starting an AI agent, records matching documentation and lessons, and flags configurable risk terms for the focused prompt
- `src/server.mjs` — local HTTP + SSE server for the browser dashboard
- `src/dashboard.html` — real-time browser dashboard (vanilla HTML/CSS/JS, zero deps)
- `agent-pipeline serve [--port N]` CLI command to start the dashboard
- `PRODUCT.md` — full product and architecture documentation
- `AGENTS.md` — AI coding agent instructions for contributors working on this repo
- `CLAUDE.md` — Claude Code-specific instructions (imports AGENTS.md and PRODUCT.md)
- `CONTRIBUTING.md` — contributing guide with adapter extension patterns
- `CHANGELOG.md` — this file
- `LICENSE` — MIT license
- `templates/examples/enterprise-tfvc.config.json` — generic TFVC + ClickUp example config
  (renamed and de-branded from internal HealingCloud example)

### Changed
- Added an npm package file allowlist for runtime files, templates, and documentation
- Consolidated shared instructions in `AGENTS.md`; removed root/template `CLAUDE.md` wrappers and stopped generating them during `init`
- README: removed HealingCloud-specific language; project is now fully generic
- README: updated example config filename reference to `enterprise-tfvc.config.json`

---

## [0.2.0] — 2026-09

### Added
- Plan job with separate lock from the code job (can run in parallel)
- `plan.snapshotGuard` — blocks the ticket if the planning agent edits any project file
- `plan.requireQaCoverage` — every acceptance check (AC1, AC2 …) must be covered in qa.json
- `docs.requireUpdate` — feature README must be updated (or park.json explains why not)
- `docs.requireLessonOnRedo` — lesson.json is required on every redo pass
- `docs.changelog` — pipeline appends one line per ticket to the feature CHANGELOG.md
- `agent.plan` section — separate provider, model and time limit for the planning job
- `agent.fallback` — ordered list of fallback providers when the primary is on hold
- `agent.scrubEnv` — additional env vars to strip before the agent starts
- `comments.onPlan` / `comments.onFailure` — opt-out of pipeline comments on the tracker
- `vcs.smokeCommand` — optional smoke test after deploy
- `agent-pipeline docs scaffold <slug>` command to create a new feature README
- `agent-pipeline ticket set <id> <statusKey>` works with ClickUp too
- High-risk plan approval flow (`needs approval` status, human sets to `ready`)
- Need-info flow for both plan and code jobs
- Stale lock recovery (dead-process detection by PID)
- `limits.lockStaleMinutes` config option
- `limits.unavailableHoldMinutes` — separate hold time for missing/logged-out tools

### Changed
- `stateDir` default changed from `.agent-pipeline` to `.pipeline-state`
- `artifacts.dir` default changed from `_pipeline/{ticket}` to `.pipeline/tickets/{ticket}`
- Prompt structure: ticket text and comments are explicitly marked as data, not instructions

### Fixed
- Pipeline comments were being fed back as human comments on the next run (now filtered)
- Corrupt state file raises an error instead of silently resetting to null

---

## [0.1.0] — 2026-06

### Added
- Initial release
- Core pipeline loop: code, verify (artifacts + build + unit tests), QA, check-in, deploy batch
- File tracker (JSON) and ClickUp tracker
- Git VCS adapter (branch per ticket, commit, push) and custom-command VCS adapter
- Codex, Claude Code, and Cursor agent presets
- `agent-pipeline init` — scaffolds config, job files and docs skeleton
- `agent-pipeline doctor` — checks Node version, config, AI tool, tracker and QA command
- `agent-pipeline run` / `loop` — one tick or continuous scheduling
- `agent-pipeline status` — show pipeline state as JSON
- `agent-pipeline ticket` — add, list, show, comment, set status (file tracker)
- `agent-pipeline docs find/index/scaffold` — feature documentation helpers
- 23 integration tests using Node's built-in test runner, zero external deps
- Atomic state writes (write-then-rename, never half-written)
- Path traversal validation in park.json
- Credential scrubbing from agent environment
- Quota-hit and unavailable-tool hold system
- `redo` with failure evidence, lesson.json requirement, `blocked` after maxAttempts
