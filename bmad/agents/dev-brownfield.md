# Agent: Developer — Brownfield Extension

> **Load this file alongside your standard BMAD `dev` agent persona.**
> It patches the developer workflow with spec-gen intelligence for brownfield codebases
> (existing code without explicit architecture documentation).
>
> Requires: spec-gen MCP server connected and `spec-gen analyze` run at least once.

---

## When This Extension Activates

Apply this extension whenever the project is brownfield — i.e., one or more of these is true:

- No `openspec/` directory exists or it is incomplete
- The codebase predates the current sprint / story pipeline
- The architecture is undocumented or only partially documented
- You are asked to modify code you have never seen before in this session

---

## Mandatory Pre-Implementation Gate

**Before writing a single line of code for any story, run this gate.**

### Step 1 — Orient

Call `orient` with the story title + first acceptance criterion as the task description.

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

Extract from the result:
- **`relevantFunctions`** — the functions most likely to be touched
- **`insertionPoints`** — where new code should land
- **`specDomains`** — which OpenSpec domains are in scope
- **`callNeighbours`** — the blast radius of each candidate

If `orient` returns an error about missing cache, run `analyze_codebase` first, then retry.

### Step 2 — Impact check

For each of the top 3 `relevantFunctions`, call `analyze_impact`.

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

Record:
- `riskScore` (0–100)
- `recommendedStrategy` (extract / split / facade / delegate)
- Top 3 upstream callers (must not break)

### Step 3 — Gate decision

| Condition | Action |
|-----------|--------|
| All `riskScore` < 40 | Proceed to implementation |
| Any `riskScore` 40–69 | Proceed with caution — note callers, add tests if missing |
| Any `riskScore` ≥ 70 | **Stop.** Run `bmad/tasks/brownfield-refactor.md` first, then return |
| `recommendedStrategy` == `facade` or `delegate` | Propose the refactor to the user before implementing the story |

**Never implement a story on a function with `riskScore ≥ 70` without first refactoring it.**

---

## Story Implementation Flow (Brownfield)

### Phase 1 — Understand before touching

1. Check OpenSpec if domains were found in Step 1:

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

2. Get the skeleton of each file you plan to modify:

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

3. Confirm insertion point with the user before writing code.

### Phase 2 — Implement

Follow your standard BMAD dev implementation workflow.
Scope changes strictly to functions identified in Step 1.

**Do not touch functions outside the `orient` result scope without re-running the gate.**

### Phase 3 — Verify

After implementation:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>check_spec_drift</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

| Drift result | Action |
|---|---|
| No drift | ✅ Done |
| `gap` on existing spec | Run `spec-gen generate --domains $DOMAIN` |
| `uncovered` on new file | Note it; propose `spec-gen generate` after PR merge |
| `stale` | Fix the stale reference; do not leave dead spec links |

Update the story's **Dev Agent Record** section with:
- Files touched
- Risk scores observed
- Any drift found and how resolved

---

## Absolute Constraints (Brownfield)

- Never modify code outside the scope identified by `orient`
- Never implement on `riskScore ≥ 70` without prior refactor approval
- Always run `check_spec_drift` as the final step
- If `orient` returns 0 results, do NOT proceed blindly — run `analyze_codebase` and retry
- If the project has no `openspec/`, note it in the story Dev Record and propose running `spec-gen generate` post-implementation
