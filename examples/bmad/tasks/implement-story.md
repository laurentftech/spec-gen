# Task: Implement Story

**Purpose**: Implement a BMAD story on any codebase — new or existing.
Structural analysis is used proportionally to the risk level already known from planning.

---

## Inputs

From the story file:
- `$STORY_TITLE`, `$AC`, `$PROJECT_ROOT`
- `$RISK_CONTEXT` — the `risk_context` section (pre-filled by Architect Agent at planning time)

If `.claude/antipatterns.md` exists, read it and store as `$ANTIPATTERNS`.
This list will be cross-checked at Step 4b.

---

## Step 1 — Read the risk context

Open the story file and check whether `risk_context` is populated.

### If risk_context IS present (normal case — planning was done)

Use it directly. Do not re-run structural analysis unless something feels wrong.

| Risk level in story | Approach |
|---|---|
| 🟢 low (< 40) | Proceed to Step 3. Quick orient to confirm insertion point. |
| 🟡 medium (40–69) | Run Step 2 impact check. Proceed with callers protected. |
| 🔴 high / critical (≥ 70) | Story should have a blocking refactor. If not scheduled, stop and flag it. |

### If risk_context is ABSENT (planning was skipped or story is new)

Run the full orientation in Step 2 before proceeding.

---

## Step 2 — Orient (full or confirm)

**Full orient** (risk_context absent, or medium+ risk):

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>orient</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "task": "$STORY_TITLE — $AC1",
    "limit": 7
  }</arguments>
</use_mcp_tool>
```

If orient returns `"error": "no cache"` → run `analyze_codebase` first, then retry.

**For medium+ risk**, also run impact on the top 2 functions:

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

If a function has `riskScore ≥ 70` that was NOT flagged at planning: **stop**.
Create a blocking refactor story and do not implement until it's resolved.

---

## Step 2.5 — Audit spec coverage of the target domain

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

If both are clean, continue to Step 3 without action.

---

## Step 3 — Check the spec

First verify that OpenSpec specs exist for this project:

```bash
ls $PROJECT_ROOT/openspec/specs/ 2>/dev/null | wc -l
```

**If 0 specs found:**
> No OpenSpec specs exist yet for this project. `search_specs` will return empty
> results and `check_spec_drift` (Step 7) will flag all files as uncovered.
>
> The Architect agent should have run `spec-gen generate` during onboarding.
> If it hasn't been run yet, note it in the Dev Agent Record and proceed with
> structural analysis only. The spec baseline can be created post-sprint with
> `spec-gen generate $PROJECT_ROOT`.

Skip `search_specs` and go to Step 4.

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

If relevant requirements are found, read the domain spec before writing code.
Note any constraints that apply to the implementation.

---

## Step 4 — Find the insertion point

Use the `insertion_points` from `risk_context` if present. Otherwise:

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

Confirm the approach with the user before writing code.

### Step 4b — Adversarial self-check

Before writing any code, state explicitly what could break with this approach.
If `$ANTIPATTERNS` was loaded (see Inputs), include any applicable patterns.

> "Risk check on `$INSERTION_POINT`:
> - `$CALLER_A` and `$CALLER_B` depend on this function — verify their assumptions hold after the change.
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

Do not touch functions outside the scope from Step 2/risk_context without re-running the gate.

---

## Step 6 — Tests

Two levels, both required before proceeding:

**Mandatory — existing tests must not regress:**
Run the full test suite. If any pre-existing test breaks, fix the regression before continuing.
A green CI on existing tests is the minimum gate.

**Recommended — at least one new test per AC:**
Write a test that directly exercises the new behaviour described in the acceptance criterion.
This is the proof that the implementation matches the intent — without it, the spec update in Step 7 has no evidence.

| Situation | Action |
|---|---|
| All tests green, new tests written | Proceed to Step 7 |
| Existing test broken | Fix regression. Do not proceed. |
| New test reveals a misunderstanding of the AC | Return to Step 5, adjust implementation |
| Brownfield: no existing test coverage | Write the new test anyway. Note the coverage gap in the Dev Agent Record. |

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
| `uncovered` on new files | Propose `spec-gen generate` post-sprint |
| `gap` on existing domain | Run `spec-gen generate --domains $DOMAIN` |
| `stale` | Fix the reference |
| No drift | ✅ |

If drift is found on a domain touched by this story, note it in the Dev Agent Record — the spec update can be proposed after the sprint, not mid-implementation.

---

## Step 8 — Update the story

Fill in the **Dev Agent Record** section of the story file and mark as `Review`.

Include:
- test files written / modified
- whether existing coverage was sufficient or a gap remains
- any drift found in Step 7

---

## Absolute constraints

- Do not write code before Step 4 confirmation
- Step 4b adversarial self-check is mandatory — never skip it
- If riskScore ≥ 70 was not caught at planning — stop, do not work around it
- Do not run `check_spec_drift` before tests are green
- Do not propose a spec update on untested code
