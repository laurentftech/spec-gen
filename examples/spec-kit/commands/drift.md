---
description: "Post-implementation spec drift check — verify the implementation matches existing OpenSpec specifications."
tools:
  - 'spec-gen/check_spec_drift'
---

# spec-gen: Drift Check

Run this command **after** `/speckit.implement` and **only once tests are green**.

It compares the implementation against existing OpenSpec specifications and reports
gaps, stale references, and uncovered files.

> **No specs yet?** If `spec-gen generate` has not been run on this project,
> this command will report everything as uncovered — that is expected and not a problem.
>
> **What to do:** Run `spec-gen generate $PROJECT_ROOT` now to create a spec baseline
> from the current codebase. Once generated, re-run this command — future drift checks
> will be meaningful. A baseline only needs to be created once.

## Prerequisites

1. spec-gen MCP server configured in your AI agent settings
2. Tests passing — do not run drift check on a red test suite
3. `spec-gen analyze` run at least once (same requirement as orient)

## User Input

$ARGUMENTS

If a project directory is provided, use it. Otherwise use the current working directory.

## Step 1 — Check spec baseline

```bash
ls $PROJECT_ROOT/openspec/specs/ 2>/dev/null | wc -l
```

**If 0 specs found:**
> "No OpenSpec specs exist yet. Running `check_spec_drift` now will flag all files as
> uncovered, which is not actionable.
>
> Run `spec-gen generate $PROJECT_ROOT` first to create a spec baseline, then re-run
> this command. The generate step takes a few minutes and only needs to be done once."
>
> Ask: "Run `spec-gen generate` now? (yes/no)"
> - Yes → trigger generate, then proceed to Step 2
> - No → stop here, remind user to run it before next drift check

**If specs exist**: proceed.

## Step 2 — Confirm tests are green

Ask the user: "Are all tests passing?"

If the answer is no: "Run tests first and fix any failures. Drift check is only
meaningful on a green test suite." Stop here.

## Step 3 — Run drift check

```
spec-gen check_spec_drift
  directory: $PROJECT_ROOT
```

## Step 4 — Interpret results

| Drift type | Meaning | Action |
|---|---|---|
| `uncovered` on new files | New code not yet in any spec | Note for post-sprint spec update |
| `gap` on existing domain | Existing spec missing coverage of new behaviour | Run `spec-gen generate --domains $DOMAIN` |
| `stale` | Spec references a function that no longer exists | Fix the reference in the spec file |
| No drift | ✅ Implementation matches specs | Done |

## Step 5 — Output

Report findings in a compact table. For each gap or uncovered item:
- Which file / domain is affected
- Recommended action (generate, update, or fix)

If drift is found on domains touched by this implementation:
> "Spec drift detected. These updates can be applied now with `spec-gen generate`
> or batched post-sprint. Recommend: note them in `.specify/{feature}/plan.md`
> under a `## Spec Updates` section rather than interrupting the current sprint."

If no drift:
> "✅ No spec drift. Implementation is consistent with existing OpenSpec specifications."
