---
name: spec-gen-implement-story
description: Implement a story on a brownfield codebase using spec-gen structural context. Runs orient + risk check before coding, validates against specs, enforces a test gate before drift check.
license: MIT
compatibility: spec-gen MCP server
user-invocable: true
allowed-tools:
  - ask_followup_question
  - use_mcp_tool
  - read_file
  - write_file
  - str_replace_based_edit
  - replace_in_file
  - run_command
  - spec-gen-execute-refactor
---

# spec-gen: Implement Story

## When to use this skill

Trigger this skill when the user asks to **implement a story or task** on a codebase that has
spec-gen analysis available, with phrasings like:
- "implement story X"
- "work on task Y"
- "start implementing this feature"
- explicit command `/spec-gen-implement-story`

**Prerequisite**: spec-gen analysis must exist (`spec-gen analyze` has been run).
If `orient` returns `"error": "no cache"` → run `analyze_codebase` first, then retry.

---

## Step 1 — Read the story and risk context

Read the story file. Extract:
- `$STORY_TITLE`, `$AC` (acceptance criteria), `$PROJECT_ROOT`
- `$RISK_CONTEXT` — the `risk_context` section if present (pre-filled by Architect Agent)

| Situation | Approach |
|---|---|
| `risk_context` present, risk 🟢 < 40 | Skip to Step 3 — use insertion point from context |
| `risk_context` present, risk 🟡 40–69 | Run Step 2 impact check, then proceed |
| `risk_context` present, risk 🔴 ≥ 70 | Stop — a blocking refactor story must be resolved first |
| `risk_context` absent | Run the full Step 2 orientation |

---

## Step 2 — Orient and assess risk

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>orient</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "task": "$STORY_TITLE",
    "limit": 7
  }</arguments>
</use_mcp_tool>
```

For the top 2 functions returned, check risk:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_impact</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "symbol": "$FUNCTION_NAME",
    "depth": 2
  }</arguments>
</use_mcp_tool>
```

**If any function has `riskScore ≥ 70`: stop.**
Do not implement. Run `/spec-gen-execute-refactor` on the blocking function first, or create a
blocking refactor task and return to this story once the risk is resolved.

---

## Step 3 — Check the spec

First, verify that OpenSpec specs exist:

```bash
ls $PROJECT_ROOT/openspec/specs/ 2>/dev/null | wc -l
```

**If 0 specs found:**
> No OpenSpec specs exist yet. `search_specs` will return empty results and
> `check_spec_drift` (Step 7) will flag everything as uncovered.
>
> Recommended: run `/spec-gen-generate` after this story to create a spec baseline.
> You only need to do this once.
>
> Continuing with structural analysis only.

Skip the `search_specs` call and go to Step 4.

**If specs exist:**

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>search_specs</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "query": "$STORY_TITLE",
    "limit": 5
  }</arguments>
</use_mcp_tool>
```

If relevant requirements are found, read the domain spec before writing any code.
Note any constraints that apply.

---

## Step 3.5 — Audit spec coverage of the target domain

Run a parity audit to check if the domain you're about to touch has spec gaps.

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>audit_spec_coverage</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

From the result, check:
- `staleDomains` — if the target domain appears here, its spec is outdated.
  Recommend running `spec-gen generate --domains $DOMAIN` before implementing.
- `hubGaps` — uncovered hub functions. If the feature touches one of these,
  add it to the adversarial check in Step 4b (high blast radius + no spec = risk).

If both are clean, continue to Step 4 without action.

---

## Step 4 — Find the insertion point

Use `insertion_points` from `risk_context` if present. Otherwise:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>suggest_insertion_points</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "description": "$STORY_TITLE",
    "limit": 5
  }</arguments>
</use_mcp_tool>
```

Read the skeleton of the target file:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_function_skeleton</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "filePath": "$TARGET_FILE"
  }</arguments>
</use_mcp_tool>
```

**Confirm the approach with the user before writing code.**

### Step 4b — Adversarial challenge

Before writing any code, state explicitly what could break with this approach.
If `.claude/antipatterns.md` exists, read it and include any applicable patterns.

> "Risk check on `$INSERTION_POINT`:
> - `$CALLER_A` and `$CALLER_B` depend on this function — verify their assumptions
>   hold after the change.
> - `$EDGE_CASE` is not covered by the current test suite — add it in Step 6.
> - [if antipatterns apply] AP-NNN (`$PATTERN_NAME`) — `$RULE` — applies here because `$REASON`."

This is not a gate — do not wait for user input. It is a mandatory self-check
that must appear in the output before the first line of code is written.

---

## Step 5 — Implement

Apply changes in this order:
1. New types/interfaces (if needed)
2. Core logic at the insertion point
3. Updated call sites (if any)

Do not touch functions outside the scope identified in Step 2 / `risk_context` without
re-running the gate.

**Small model constraint**: if the model is under 13B parameters (Mistral Small, Phi, Gemma…),
each edit must touch a contiguous block of at most 50 lines. Split larger changes.

---

## Step 6 — Tests

Both levels required before proceeding to Step 7.

**Mandatory — existing tests must not regress:**
Run the full test suite. If any pre-existing test breaks, fix the regression before continuing.

**Recommended — at least one new test per AC:**
Write a test that directly exercises the behaviour described in the acceptance criterion.

| Situation | Action |
|---|---|
| All tests green, new tests written | Proceed to Step 7 |
| Existing test broken | Fix regression. Do not proceed. |
| New test reveals a misunderstanding of the AC | Return to Step 5, adjust implementation |
| Brownfield: no existing test coverage | Write the new test anyway. Note the coverage gap. |

---

## Step 7 — Verify drift

Only run once tests are green.

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>check_spec_drift</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

| Drift type | Resolution |
|---|---|
| `uncovered` on new files | Note it — propose `spec-gen generate` post-sprint |
| `gap` on existing domain | Run `spec-gen generate --domains $DOMAIN` |
| `stale` | Fix the reference |
| No drift | Done |

---

## Absolute constraints

- Do not write code before Step 4 confirmation
- If `riskScore ≥ 70` — stop, do not work around it, run `/spec-gen-execute-refactor` first
- Do not run `check_spec_drift` before tests are green
- Do not propose a spec update on untested code
