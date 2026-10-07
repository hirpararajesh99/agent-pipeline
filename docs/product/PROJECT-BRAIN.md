# Project Brain vision

Status: agreed product direction; implementation is partial. This document records
Rajesh Hirpara's Project Brain brief and the subsequent recommendations. It is a
design reference, not a promise that every capability is available.

Project Brain turns scattered knowledge in an existing or legacy codebase into
structured, reusable context that helps coding agents understand the system,
assess change impact, and make validated changes with less repeated explanation.

See [current capabilities](../features/project-brain/README.md),
[architecture](ARCHITECTURE.md), and [delivery roadmap](ROADMAP.md).

## Problem and users

Developers maintaining unfamiliar projects must reconstruct architecture, business
rules, dependencies, conventions, and constraints before changing code. When a
module's author leaves, undocumented reasons and operational knowledge leave too.
New developers and new AI sessions repeat that investigation. General documentation
often misses the detail needed for a specific change, increasing review burden.

The first users are maintainers and teams working on legacy applications, initially
legacy .NET Framework and modern .NET. The architecture should allow Java, Python,
Node, PHP, and other language adapters over time. Support claims must describe actual
analysis coverage, not merely the ability to enumerate a file extension.

## Relationship to Agent Pipeline

Agent Pipeline manages tickets, planning, execution, validation, and delivery.
Project Brain supplies persistent project understanding to that workflow and should
also provide context usable by an external coding agent. Markdown knowledge is
portable and reviewable in version control. Structured records support retrieval,
relationships, evidence tracking, and freshness checks.

## Knowledge to capture

| Area | Expected knowledge |
| --- | --- |
| Architecture | Layers, responsibilities, boundaries, communication patterns |
| Modules and flows | Entry points, execution paths, background jobs, affected components |
| Business rules | Conditions, calculations, exceptions, and documented rationale |
| Data | Tables, relationships, queries, stored procedures, migration conventions |
| Integrations | External contracts, configuration dependencies, failure behaviour |
| Patterns | Existing implementations and examples a change should follow |
| Legacy constraints | Quirks, protected areas, compatibility obligations |
| Validation | Available builds/tests, environment requirements, verification gaps |
| Features | Focused context linking a feature to its code and related knowledge |
| Decisions and lessons | Developer explanations, failed approaches, corrections, scope |

## Initial understanding workflow

1. Inspect actual source, project files, configuration, tests, and existing docs.
   Use relevant Git history when available; report its absence otherwise.
2. Create a cheap deterministic repository map and initial context.
3. Generate ordered prompts for focused analysis by an external coding agent.
4. Analyse the selected module in stages, reusing earlier findings. A full-project
   analysis is optional; users must not need it before their first useful task.
5. Write modular findings with source references and explicit uncertainty.
6. Produce a concise synthesis linking to detailed findings and open questions.

The analysis phase must leave application source unchanged. Generated prompts must
direct the agent to inspect real files, avoid invented business rules or history,
and record gaps. Output validation must enforce the permitted documentation scope.

## Future task workflow

1. Understand intent and acceptance criteria from chat or a ticket.
2. Retrieve relevant project and feature knowledge within a context budget.
3. Verify that knowledge against current source and established examples.
4. Trace dependencies, behaviour, and possible side effects; surface conflicts.
5. Plan the change and obtain review when required by configured risk policy.
6. Implement focused changes that preserve required behaviour and public contracts.
7. Run appropriate checks and report failures and unverified areas honestly.
8. Review the result and refresh affected knowledge after accepted changes.

The chat entry point and expanded policy controls are future work. Existing ticket
and CLI workflows remain the starting point.

## Knowledge quality requirements

- Evidence: each finding identifies source files, symbols or sections, and the
  examined revision or content hashes. Line numbers alone are insufficient.
- Certainty: distinguish verified findings, inferences, and unknowns. Record how
  a finding was verified; an AI assertion is not proof.
- Freshness: independently track current, stale, or unchecked evidence. A file
  change triggers review of related findings, not automatic rejection of all of them.
- Human rationale: retain attributed developer explanations and decisions separately
  from machine inferences. Code alone cannot recover undocumented intent.
- Conflicts: preserve disagreements among source, docs, tickets, and human decisions.
  Source describes existing behaviour; approved requirements describe intended
  behaviour. Material unresolved conflicts must be visible before implementation.
- Context transparency: explain selected and omitted context, selection reasons,
  budget limits, and gaps. Agents may investigate beyond the selection.
- Incremental analysis: reuse unchanged findings and reanalyse affected areas.
  Build deeper knowledge as tasks require it rather than repeatedly scanning everything.
- Lessons: record applicability, evidence, review state, and supersession. Detect
  duplicates and retire outdated lessons. Saving a lesson does not train the model
  or guarantee that future agents will avoid the same mistake.
- Boundaries: respect repository exclusions and access limits; do not copy secrets
  or credentials into knowledge, prompts, or logs. Document what is sent to an agent.

## Success and limits

The first outcome to prove: a developer unfamiliar with a legacy .NET module can
explain its flow, identify constraints, and make a reviewed change using traceable
context. Measure investigation time, context input tokens, developer corrections,
missed dependencies, and validation results against a comparable baseline.

Token reduction and better reliability are hypotheses until measured. Report initial
analysis cost separately from repeated-task cost. Count output/retry costs too where
available, and label estimates when providers do not expose token usage.

Project Brain does not replace developer judgment, provide a complete runtime call
graph by default, discover unknown rationale with certainty, or remove the need to
inspect current source. Avoid unrelated modernization when maintaining legacy code.

## Maintaining these documents

Keep product intent here, technical decisions in the architecture document, delivery
acceptance criteria in the roadmap, and verified usage in the feature README. Update
status and evidence when work ships. Historical prototype paths and proposed commands
must stay labelled as proposals until implemented and tested.
