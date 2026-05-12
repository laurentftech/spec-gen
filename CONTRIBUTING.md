# Contributing to openlore

Thank you for your interest in contributing. This document covers how to set up your development environment, run tests, and submit changes.

## Development Setup

**Requirements:** Node.js ≥ 20, npm ≥ 9

```bash
git clone https://github.com/clay-good/openlore
cd openlore
npm install
```

Build TypeScript (outputs to `dist/`):

```bash
npm run build
```

Run the CLI directly during development (no build step needed):

```bash
npm run dev -- init
npm run dev -- analyze
npm run dev -- generate
```

## Agent Context Setup (one-time, after cloning)

`CLAUDE.md` references `.openlore/analysis/CODEBASE.md`, which is git-ignored and must be generated locally:

```bash
npm run build
npm run dev -- analyze    # or: openlore analyze if installed globally
```

See [Agent Setup](README.md#agent-setup) in the README for the full explanation of what this file contains and why it matters.

## Running Tests

```bash
# Run all tests once
npm run test:run

# Run in watch mode during development
npm test

# Run with coverage report
npm run test:coverage

# Run a specific test file
npm run test:run -- src/cli/commands/analyze.test.ts
```

Tests use [Vitest](https://vitest.dev/). The test suite runs entirely in-process with mocked filesystem/process calls — no real API calls or disk writes.

## Integration & E2E Tests

The e2e suite (`src/core/analyzer/e2e.integration.test.ts`) runs the full `analyze` pipeline against the real openlore codebase and verifies that semantic queries return the correct source files. It is the primary non-regression guard for the analyzer.

**Prerequisites:**

```bash
npm run embed:up              # start the embedding server (Docker)
openlore analyze --embed      # build / refresh the vector index
```

**Run:**

```bash
npm run test:e2e
```

Tests auto-skip when the embedding server or index is missing, so they never break a cold CI environment. They do not replace `npm run test:run` — run both.

**When to run before committing:**

| Change area | Required |
|---|---|
| `src/core/analyzer/**` | yes |
| `src/core/generator/stages/**` | yes |
| `src/core/services/mcp-handlers/**` | yes |
| Everything else | recommended |

## Type Checking

```bash
npm run typecheck
```

This must pass with zero errors before any PR is merged. The project uses strict TypeScript.

## Linting

```bash
npm run lint
```

Uses ESLint with typescript-eslint. Fix lint errors before submitting.

## Project Structure

```
src/
├── api/              Programmatic API (no process.exit, no console.log)
├── cli/
│   ├── commands/     One file per CLI command + matching .test.ts
│   └── index.ts      CLI entry point
├── core/
│   ├── analyzer/     Static analysis (file walker, dependency graph, etc.)
│   ├── drift/        Drift detection and spec mapping
│   ├── generator/    Spec generation pipeline and OpenSpec writer
│   └── services/     Shared services (LLM, config, MCP handlers)
├── types/            Shared TypeScript interfaces
├── utils/            Utilities (logger, errors, shutdown, etc.)
└── constants.ts      All magic numbers and path strings
```

### Key conventions

- **Constants:** All magic numbers and path strings belong in `src/constants.ts`. Never hardcode `.openlore`, `openspec`, subdirectory names, or numeric thresholds inline.
- **API vs CLI:** The `src/api/` layer must never call `process.exit()` or write to stdout/stderr directly — it only throws errors. The `src/cli/` layer handles all user-facing output.
- **File existence:** Use the async `fileExists()` from `src/utils/command-helpers.ts` instead of `fs.existsSync()` in async contexts.
- **Error classes:** Use the `errors.*` factory functions in `src/utils/errors.ts` for typed, user-facing errors.

## Writing Tests

Every CLI command file (`src/cli/commands/foo.ts`) should have a matching `foo.test.ts`. Follow the patterns in existing test files:

1. Mock `../../utils/logger.js` to suppress output
2. Mock heavy dependencies (`repository-mapper`, `dependency-graph`, etc.)
3. Test command configuration (options, defaults, descriptions)
4. Test validation paths (invalid inputs should set `process.exitCode = 1`)
5. Test the happy path using mocked services

For each `beforeEach`, reset `process.exitCode = undefined` and call `vi.clearAllMocks()`.

## Submitting Changes

1. Fork the repository and create a branch: `git checkout -b my-feature`
2. Make your changes — keep PRs focused on a single concern
3. Ensure `npm run typecheck`, `npm run lint`, and `npm run test:run` all pass
4. If touching `src/core/analyzer/`, `src/core/generator/stages/`, or `src/core/services/mcp-handlers/`: run `npm run test:e2e` (requires `npm run embed:up` and a fresh index)
5. Open a pull request with a clear description of the change and why

## Reporting Bugs

Open an issue at https://github.com/clay-good/openlore/issues with:
- The command you ran
- The error message or unexpected output
- Your OS, Node.js version (`node --version`), and openlore version (`openlore --version`)
- Output of `openlore doctor` if relevant
