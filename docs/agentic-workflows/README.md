# openlore as a Structural Context Provider

openlore MCP can be integrated into any agentic coding workflow — regardless of the
method or framework used (BMAD, Claude Code rules, Cursor rules, LangGraph, etc.).

The core value: **structural knowledge of the codebase is available to agents at the
right moment, before they start writing code.**

---

## The problem it solves

Coding agents are context-blind by default. Given a task, an agent reads a few files and
starts implementing — without knowing:

- which functions have 15 callers and will break if modified
- which areas of the codebase are already spec'd and what those specs say
- whether the insertion point it chose is a hub that three other stories also touch

openlore MCP provides that knowledge on demand, from a pre-built index of the codebase.

---

## Generic integration pattern

Any agentic workflow can adopt openlore by following three primitives:

### 1 — Pre-flight check (before writing code)

```
orient(task_description)          → scope: files, functions, specs, call paths
analyze_impact(top_functions)     → risk scores, callers to protect
```

If any function has `riskScore ≥ 70` → stop, do not implement, create a refactor task first.

### 2 — Spec alignment (before and after)

```
search_specs(task_description)    → existing requirements that apply
check_spec_drift()                → verify implementation matches spec after coding
```

### 3 — Test gate

Tests must pass before `check_spec_drift` is meaningful.
Do not propose spec updates on untested code.

---

## Risk levels

| Score | Level | Approach |
|---|---|---|
| < 40 | 🟢 low | Quick orient, proceed |
| 40–69 | 🟡 medium | Full impact check, protect callers |
| 70–100 | 🔴 high / critical | Stop — refactor first |

---

## MCP tools by phase

| Phase | Tool | Purpose |
|---|---|---|
| Before coding | `orient` | Scope functions, files, specs, insertion points |
| Before coding | `analyze_impact` | Callers, risk score, blast radius |
| Before coding | `search_specs` | Existing requirements that apply |
| Before coding | `suggest_insertion_points` | Where to add code safely |
| Before coding | `generate_change_proposal` | Structured risk analysis from a task description |
| Planning | `get_architecture_overview` | Domain clusters, cross-dependencies |
| Planning | `get_refactor_report` | High-risk functions to sequence first |
| Planning | `get_critical_hubs` | High fan-in bottlenecks |
| Planning | `annotate_story` | Write risk context into a task/story file |
| After coding | `check_spec_drift` | Verify implementation matches spec |
| After coding | `get_subgraph` | Confirm blast radius was contained |

---

## Implementations

| Method | Assets |
|---|---|
| **BMAD** | [`examples/bmad/`](../../examples/bmad/) — agents, tasks, templates, skills |
| **Mistral Vibe** | [`examples/mistral-vibe/`](../../examples/mistral-vibe/) — reusable skills for analyze, generate, plan-refactor, execute-refactor, implement-story |
| **spec-kit** | [`examples/spec-kit/`](../../examples/spec-kit/) — extension with `before_implement` / `after_implement` hooks |
| **get-shit-done** | [`examples/gsd/`](../../examples/gsd/) — `/gsd:openlore-orient` + `/gsd:openlore-drift` Claude Code commands |
| Claude Code | Add `orient` + `analyze_impact` calls to your `CLAUDE.md` workflow section |
| Cursor | See pre-flight `.cursorrules` pattern in this doc |

---

## Cursor / generic rules pattern

Add to `.cursorrules` or any agent system prompt:

```
Before writing any code:
1. Call openlore orient("$TASK") — use the returned functions and specs to scope your work
2. Call openlore analyze_impact on the top 2 functions — if riskScore ≥ 70, stop and report
3. Call openlore search_specs("$TASK") — read any matching requirements before coding

After writing code:
4. Confirm tests pass
5. Call openlore check_spec_drift — resolve any gaps before closing the task
```

---

## Onboarding a new codebase

Before any of the above works, the index must exist:

```bash
openlore analyze          # builds call graph + vector index (~2–5 min)
openlore generate         # generates OpenSpec specs from analysis
```

Re-run `analyze` after significant structural changes. `generate` can be run per-domain:

```bash
openlore generate --domains auth,users   # refresh only changed domains
```
