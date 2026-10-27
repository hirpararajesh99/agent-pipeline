# Release readiness

Assessment date: 2026-10-27. This is a local engineering assessment, not evidence
that a release has been published or a real customer project has been validated.

## Can people use it now?

The repository is suitable for a limited source-code developer preview with the
current limitations clearly disclosed. Start with standalone Project Brain analysis
on a disposable checkout and review the findings. Public beta and production
readiness are not established. Completing all future roadmap features is not a
prerequisite for a focused beta, but its supported workflow must be demonstrated.

The current scope is a local CLI and local dashboard. It is not a public hosted
service. This work does not publish to npm, change repository visibility, push a
release, or invite external testers.

## Evidence collected

| Check | Result and limits |
| --- | --- |
| Automated regression suite | All 87 tests passed on Windows with Node 24.22.1; fake providers and local fixtures, including refresh/recovery, review history and lesson lifecycle |
| Minimum runtime and other operating systems | Node 18.17 is declared; it and macOS/Linux were not exercised in this review |
| Package contents | Added an explicit `files` allowlist for runtime, templates, and documentation; development tests and local state are excluded |
| Local installation | Packed a tarball and installed it offline into a fresh temporary consumer directory; no npm dependencies downloaded |
| Installed CLI | Windows command shim passed help, init, standalone brain init/status/freshness, and detection of an edited source file |
| Installed refresh workflow | Updated local tarball passed prepare, explicit accept, and freshness checks; original run retained its stale historical evidence |
| Installed review workflow | Fresh local tarball installed offline; decision creation, scoped knowledge, conflict creation, resolution and reopening preserved event history |
| Installed lesson workflow | Fresh local tarball installed offline; review, correction, retirement and show preserved three revisions and left original Markdown unchanged |
| Instruction scaffolding | Installed init creates AGENTS.md and does not create CLAUDE.md |
| License | Repository includes LICENSE and declares MIT in package.json |
| Real integrations | No real-provider, ClickUp, Git remote, TFVC, or deployment validation recorded here |
| Project outcomes | No real legacy/modern .NET pilot or measured investigation/token savings recorded |

Package checks exercise the locally built artifact, not registry ownership,
publication, or an npm-installed released version. No cross-platform guarantee or
production support claim follows from these checks.

## Next release gates

1. Review the repository and history for sensitive data before changing visibility.
   Define a private vulnerability-reporting route and a maintainer/issue support route.
2. Validate one documented end-to-end Brain workflow with a real provider. Record
   provider version, permissions, configuration, costs when available, and failure/retry behavior.
3. Add CI and verify the declared minimum runtime plus supported Windows/macOS/Linux
   combinations. Repeat clean-package CLI checks in the release job.
4. Review local dashboard security before wider adoption: it binds to 127.0.0.1,
   has state-changing endpoints and wildcard CORS, and currently has no authentication
   or explicit origin checks. Do not expose it as a hosted service. Keep initial
   preview instructions focused on the CLI while this review is pending.
5. Run an initial real-project pilot, inspect the evidence and corrections, and
   document concrete limitations. The full comparative pilot in roadmap Milestone 4
   remains required before claiming measured benefits or broad support.
6. Choose a prerelease version and distribution name, verify registry ownership,
   publish accurate release notes and a short onboarding example, then release a
   beta to a small tester group. Package publication remains a separate release action.

Claims such as enterprise-grade reliability, full language understanding, automatic
semantic validation, or guaranteed scaling readiness are not supported by present
evidence. Start with the workflows that are actually implemented and validated.

## Product work after the current step

Milestones 1–2 are implemented: finding freshness (2a), selective revisions (2b),
developer rationale/conflicts (2c) and lesson lifecycle (2d).
Attribution is caller-supplied, and conflict discovery is manual. Keep historical
knowledge and uncertainty intact throughout.
Incremental task context is Milestone 3. See the [roadmap](ROADMAP.md) for acceptance
criteria and the [feature guide](../features/project-brain/README.md) for runnable usage.
