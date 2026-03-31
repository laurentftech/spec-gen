# Task: Brownfield Refactor

**Purpose**: Plan and execute a safe refactoring on a brownfield codebase before implementing a story.
Typically triggered by the `dev-brownfield` agent gate when `riskScore ≥ 70`.

**Output**: `.spec-gen/refactor-plan.md` applied and verified.

---

## Inputs

- `$TARGET_FUNCTION` — function identified as high-risk by `analyze_impact`
- `$PROJECT_ROOT` — absolute path to the project

---

## Step 1 — Confirm target and scope

Present the risk signal to the user:

> "`$TARGET_FUNCTION` has a risk score of $SCORE ($ISSUES).
> Implementing the planned story on this function as-is risks breaking $CALLERS.
> This task will refactor it first. Proceed?"

If the user declines, mark the story as blocked with dependency: "Refactor `$TARGET_FUNCTION` first."

---

## Step 2 — Get the refactor report

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_refactor_report</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

Confirm `$TARGET_FUNCTION` appears in the report and note its issues and priority score.

---

## Step 3 — Check for clones

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_duplicate_report</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

If `$TARGET_FUNCTION` appears in a clone group:
> "⚠️ This function has N near-clones. Consolidate them first to reduce blast radius."
Propose consolidation as Change 0 in the plan.

---

## Step 4 — Analyse the call neighbourhood

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_impact</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "symbol": "$TARGET_FUNCTION",
    "depth": 3
  }</arguments>
</use_mcp_tool>
```

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_subgraph</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "functionName": "$TARGET_FUNCTION",
    "direction": "both",
    "format": "mermaid"
  }</arguments>
</use_mcp_tool>
```

Show the Mermaid diagram. Identify extraction candidates in the downstream subgraph.

---

## Step 5 — Find safe extraction targets

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_low_risk_refactor_candidates</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "filePattern": "$TARGET_FILE",
    "limit": 5
  }</arguments>
</use_mcp_tool>
```

Cross-reference with the subgraph: good extraction candidates are already callees of `$TARGET_FUNCTION`.

---

## Step 6 — Find landing zones for extracted helpers

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>suggest_insertion_points</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "description": "extract helper from $TARGET_FUNCTION",
    "limit": 5
  }</arguments>
</use_mcp_tool>
```

---

## Step 7 — Design the change sequence

Design an ordered sequence of atomic changes. Each change must specify:

- **What**: the exact block to extract (description or line range)
- **New name**: function name
- **Target file**: where to place it (existing or new)
- **Call sites to update**: list each file that calls `$TARGET_FUNCTION` or the extracted block

**Present the full sequence to the user and wait for explicit approval before writing the plan.**

---

## Step 8 — Execute (delegate to spec-gen-execute-refactor)

Once the plan is approved, hand off to the `spec-gen-execute-refactor` skill:

1. Write `.spec-gen/refactor-plan.md` with the full plan (see skill template)
2. Invoke `/spec-gen-execute-refactor`

The execute skill handles:
- Green baseline verification
- Restore point setup
- Atomic change application with tests after each step
- Post-refactor risk score verification

---

## Step 9 — Re-run the gate

After the refactor is complete, re-run `analyze_impact` on `$TARGET_FUNCTION`:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_impact</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "symbol": "$TARGET_FUNCTION",
    "depth": 2
  }</arguments>
</use_mcp_tool>
```

- If `riskScore` is now < 70 → return to the story implementation task
- If `riskScore` is still ≥ 70 → repeat from Step 4 with the updated subgraph

---

## Completion Criteria

- [ ] `riskScore` for `$TARGET_FUNCTION` < 70
- [ ] Full test suite passes (green)
- [ ] `check_spec_drift` clean or addressed
- [ ] Story unblocked — return to `implement-story-brownfield`
