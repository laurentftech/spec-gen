# spec-gen commands for get-shit-done (GSD)

Two Claude Code slash commands that add structural risk analysis and spec drift
verification to the [get-shit-done](https://github.com/gsd-build/get-shit-done) workflow.

Part of the [spec-gen agentic workflow pattern](../../docs/agentic-workflows/README.md).

## Commands

| Command | When | What it does |
|---|---|---|
| `/gsd:spec-gen-orient` | Before `/gsd:execute-phase` | orient + risk gate → writes `.planning/codebase/RISK-CONTEXT.md` |
| `/gsd:spec-gen-drift` | After `/gsd:verify-work` passes | drift check → appends spec status to `RISK-CONTEXT.md` |

## Installation

Copy the `commands/` directory into your project's `.claude/` folder:

```bash
cp -r examples/gsd/commands/.claude/commands/gsd/ .claude/commands/gsd/
```

Or copy into your global Claude Code commands:

```bash
cp -r examples/gsd/commands/gsd/ ~/.claude/commands/gsd/
```

## Prerequisites

1. spec-gen MCP server configured in `.claude/settings.json`
2. `spec-gen analyze $PROJECT_ROOT` run at least once

## Workflow

```mermaid
flowchart TD
    MAP["/gsd:map-codebase\nnarrative docs\n(STACK, ARCHITECTURE…)"] --> ORIENT

    subgraph SG_PRE ["spec-gen — pre-phase (brownfield)"]
        ORIENT["/gsd:spec-gen-orient\norient + analyze_impact"]
        ORIENT --> GATE{risk ≥ 70?}
        GATE -- yes --> INSERT["🔴 /gsd:insert-phase\nadd refactor phase"]
        GATE -- no --> RISK_CTX[".planning/codebase/\nRISK-CONTEXT.md"]
    end

    INSERT --> ORIENT
    RISK_CTX --> PLAN["/gsd:plan-phase N"]
    PLAN --> EXEC["/gsd:execute-phase N"]
    EXEC --> VERIFY["/gsd:verify-work N"]
    VERIFY --> TESTS{tests pass?}
    TESTS -- no --> GAP["/gsd:execute-phase --gaps-only"]
    GAP --> VERIFY
    TESTS -- yes --> DRIFT

    subgraph SG_POST ["spec-gen — post-phase"]
        DRIFT["/gsd:spec-gen-drift N\ncheck_spec_drift"]
        DRIFT --> RESULT{drift?}
        RESULT -- stale --> FIX["fix ref now"]
        RESULT -- gap --> NOTE["note → post-milestone\nspec-gen generate"]
        RESULT -- none --> CLEAN["✅ clean"]
    end

    CLEAN --> COMPLETE["/gsd:complete-milestone"]
    NOTE --> COMPLETE
    FIX --> COMPLETE

    style INSERT fill:#fdd,stroke:#c00
    style TESTS fill:#fff3cd,stroke:#ffc107
    style CLEAN fill:#d4edda,stroke:#28a745
```

```
/gsd:new-project or /gsd:map-codebase   ← existing GSD commands

# spec-gen pre-flight (brownfield)
/gsd:spec-gen-orient [phase]            ← risk gate, writes RISK-CONTEXT.md

/gsd:plan-phase [N]                     ← existing GSD command
/gsd:execute-phase [N]                  ← existing GSD command
/gsd:verify-work [N]                    ← existing GSD command

# spec-gen post-flight (once verify-work passes)
/gsd:spec-gen-drift [N]                 ← drift check, appends to RISK-CONTEXT.md

/gsd:complete-milestone                 ← existing GSD command
```

## Risk gate

| Score | Level | Action |
|---|---|---|
| < 40 | 🟢 low | Proceed to execute-phase |
| 40–69 | 🟡 medium | Proceed — protect callers listed in RISK-CONTEXT.md |
| ≥ 70 | 🔴 high / critical | Stop — use `/gsd:insert-phase` to add a refactor phase first |

## OpenSpec spec baseline

`/gsd:spec-gen-orient` uses `search_specs` to surface relevant requirements, and
`/gsd:spec-gen-drift` uses `check_spec_drift` to verify alignment. Both require
OpenSpec specs to exist — without them, results are empty or everything shows as uncovered.

| State | What to do |
|---|---|
| No specs yet | Run `spec-gen generate $PROJECT_ROOT` before the first phase — or let `/gsd:spec-gen-drift` offer to do it |
| Specs exist | Both commands work as expected |
| New code not yet spec'd | `drift` flags it as `uncovered` — run `spec-gen generate` post-milestone |

Both commands detect missing specs automatically and prompt you to generate them.

## Relation to `/gsd:map-codebase`

`/gsd:map-codebase` uses parallel mapper agents to produce narrative documents
(STACK.md, ARCHITECTURE.md, etc.) — great for onboarding and big-picture understanding.

`/gsd:spec-gen-orient` is complementary: it produces **quantitative risk data** (fan-in,
fan-out, risk scores, call paths) from a pre-built static index. Both can coexist —
run `map-codebase` once for narrative context, `spec-gen-orient` before each phase for
risk-aware execution.
