---
description: "Pre-flight structural risk check — orient + analyze_impact before implementation. Gates on riskScore ≥ 70."
tools:
  - 'spec-gen/orient'
  - 'spec-gen/analyze_impact'
  - 'spec-gen/search_specs'
---

# spec-gen: Pre-flight Check

Run this command **before** `/speckit.implement` on an existing codebase.
It identifies the functions affected by the planned tasks, scores their blast radius,
and surfaces any spec requirements that apply — so you don't discover high-risk
areas mid-implementation.

> **Greenfield projects** (no existing codebase): skip this command.
> It is only useful when implementing against an existing codebase.

## Prerequisites

1. spec-gen MCP server configured in your AI agent settings
2. `spec-gen analyze` run at least once on the project directory
   (produces the `.spec-gen/` cache used by orient)

## User Input

$ARGUMENTS

If a project directory is provided, use it. Otherwise use the current working directory.

## Step 1 — Read tasks.md

Read `.specify/{feature}/tasks.md` to extract the list of planned tasks.
Summarise the implementation intent in one sentence — this is the `$TASK_DESCRIPTION`
passed to orient.

If tasks.md does not exist, ask the user for a brief description of what they are about
to implement.

## Step 2 — Orient

```
spec-gen orient
  directory: $PROJECT_ROOT
  task: $TASK_DESCRIPTION
  limit: 7
```

If orient returns `"error": "no cache"`:
> "spec-gen has no analysis cache for this project. Run `spec-gen analyze $PROJECT_ROOT`
> first (takes ~1 min), then re-run `/speckit.spec-gen.orient`."
> Stop here.

## Step 3 — Check spec baseline

Check whether OpenSpec specifications exist for this project:

```bash
ls $PROJECT_ROOT/openspec/specs/ 2>/dev/null | head -5
```

**If no specs exist** (`openspec/specs/` is absent or empty):
> "No OpenSpec specs found. `search_specs` and `check_spec_drift` will return empty
> results until specs are generated.
>
> Recommended: run `spec-gen generate $PROJECT_ROOT` after this sprint to create a
> spec baseline from the existing code. You only need to do this once — subsequent
> sprints will have specs to align against.
>
> Continuing with structural analysis only (orient + impact)."

**If specs exist**: proceed to search_specs below.

## Step 4 — Check existing requirements

```
spec-gen search_specs
  directory: $PROJECT_ROOT
  query: $TASK_DESCRIPTION
  limit: 5
```

If relevant requirements are found, list them. Note any constraints that apply to the
planned implementation.

If `search_specs` returns no results despite specs existing, note it — the planned
change may be in an area not yet covered by specs.

## Step 5 — Impact analysis

For each of the top 2 functions returned by orient:

```
spec-gen analyze_impact
  directory: $PROJECT_ROOT
  symbol: $FUNCTION_NAME
  depth: 2
```

Build a risk summary table:

| Function | File | Risk Score | Level | Callers |
|----------|------|-----------|-------|---------|

## Step 6 — Decision gate

| Max risk score | Action |
|---|---|
| < 40 | 🟢 Proceed — risk is low. Show insertion points from orient. |
| 40–69 | 🟡 Proceed with caution — protect the callers listed above. |
| ≥ 70 | 🔴 **Stop.** Do not implement until the high-risk function is refactored. |

**If any function has riskScore ≥ 70:**

> "⚠️ High structural risk detected on `$FUNCTION_NAME` (score: $SCORE).
> Implementing against this function risks breaking $CALLER_COUNT callers.
>
> Recommended: add a refactor task to tasks.md for `$FUNCTION_NAME` and schedule
> it before the tasks that touch it. Then re-run `/speckit.spec-gen.orient`."
>
> Stop and wait for user confirmation before proceeding.

## Step 7 — Summary

Output a compact block to paste into tasks.md or plan.md as a `## Risk Context` note:

```
## Risk Context (spec-gen)
- Domains: {domains}
- Max risk: {score} {badge}
- Functions in scope: {fn1} ({file1}), {fn2} ({file2})
- Callers to protect: {callers}
- Blocking refactors: {none | list}
- Insertion point: {top insertion point}
```

Ask the user: "Paste this into your tasks.md? (yes/no)"
If yes, append it before the first task phase.
