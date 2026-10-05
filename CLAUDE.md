# Claude Code instructions for agent-pipeline

> This file is read automatically by Claude Code. It imports the full agent instructions.

@AGENTS.md
@PRODUCT.md

---

## Claude-specific guidance

### Tool permissions
When working on this codebase, you need:
- **Read**: all files
- **Write**: `src/`, `test/`, `templates/`, root markdown files
- **Bash**: `node --test test/pipeline.test.mjs` to run tests

You do **not** need and should **not** use:
- Browser/web tools (no frontend to preview — it's a CLI tool)
- Network access (tests run fully offline)

### Planning before coding
This codebase has clean, intentional architecture. Before changing anything:
1. Read `PRODUCT.md` for the full picture
2. Read the specific file(s) you are changing — they are small and self-contained
3. Check if there is an existing pattern you should follow (e.g. adding an adapter)

### Running tests after every change
Always run `node --test test/pipeline.test.mjs` after any code change.
All 23 tests must pass. The tests are fast (< 5 seconds) and require no external tools.

### What NOT to do
- Do not add npm packages — zero external dependencies is a core design goal
- Do not add `async` to `loadConfig` or `buildConfig` — they are called synchronously
- Do not change the State file format — it must remain a flat directory of JSON files
- Do not add global state (module-level mutable variables) to any adapter
- Do not change how `sanitizeText` or `redact` work without updating their tests
