# Task: Implement Story — Brownfield

**Purpose**: Safe story implementation on a brownfield codebase.
Extends the standard BMAD dev implementation task with structural analysis gates.

**Prerequisite**: Brownfield onboarding task completed (`openspec/` populated, analysis cached).

---

## Inputs

From the story file:
- `$STORY_TITLE` — story title
- `$AC` — acceptance criteria (comma-separated summary)
- `$CONSTRAINTS` — technical constraints section (if any)
- `$PROJECT_ROOT` — absolute path to the project directory

---

## Step 1 — Parse the story intent

Extract a one-sentence task description combining title + primary AC:

> "$STORY_TITLE — must $AC1"

Store as `$TASK_DESCRIPTION`.

---

## Step 2 — Orient on the codebase

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>orient</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "task": "$TASK_DESCRIPTION",
    "limit": 7
  }</arguments>
</use_mcp_tool>
```

From the result, extract:
- `relevantFunctions` → `$CANDIDATES` (list)
- `insertionPoints` → `$INSERTION_CANDIDATES`
- `specDomains` → `$DOMAINS_IN_SCOPE`
- `callNeighbours` → per candidate

If result contains `"error": "no cache"` → run `analyze_codebase` first, then retry.
If `relevantFunctions` is empty → broaden the query, try individual keywords from the title.

---

## Step 3 — Impact analysis on top candidates

For each of the top 3 candidates in `$CANDIDATES`:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_impact</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "symbol": "$CANDIDATE",
    "depth": 2
  }</arguments>
</use_mcp_tool>
```

Build a risk table:

| Function | File | Risk Score | Strategy | Top Callers |
|---|---|---|---|---|
| ... | ... | 0–100 | extract/split/facade/delegate | ... |

---

## Step 4 — Gate

| Condition | Decision |
|---|---|
| Max risk score < 40 | ✅ Proceed |
| Max risk score 40–69 | ⚠️ Proceed with caution — ensure tests exist for affected callers |
| Max risk score ≥ 70 | 🛑 Do not implement — run `bmad/tasks/brownfield-refactor.md` first |
| Strategy = `facade` or `delegate` on the primary candidate | Discuss with user before proceeding |

If blocked, add a dependency to the story: "Refactor `$FUNCTION` first (risk: $SCORE)".

---

## Step 5 — Check the spec

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>search_specs</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "query": "$TASK_DESCRIPTION",
    "limit": 5
  }</arguments>
</use_mcp_tool>
```

If relevant spec sections are found, read the full domain spec:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_spec</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "domain": "$DOMAIN"
  }</arguments>
</use_mcp_tool>
```

Note any requirements that constrain the implementation. Add them to the story's Dev Notes.

---

## Step 6 — Find the exact insertion point

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>suggest_insertion_points</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "description": "$TASK_DESCRIPTION",
    "limit": 5
  }</arguments>
</use_mcp_tool>
```

For the top candidate, visualise its neighbourhood:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_subgraph</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "functionName": "$TOP_INSERTION_POINT",
    "direction": "both",
    "format": "mermaid"
  }</arguments>
</use_mcp_tool>
```

Show the Mermaid diagram and confirm the insertion point with the user.

---

## Step 7 — Read the target file skeleton

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

Identify the exact insertion location and patterns to follow (naming, error handling, logging style).

**Confirm the approach with the user before writing code:**
> "I plan to [extend / add / hook into] `$FUNCTION` in `$TARGET_FILE` by [description].
> Risk score: $SCORE. Callers that must not break: $CALLERS. Does this match your intent?"

---

## Step 8 — Implement

Apply changes in this order:
1. New types/interfaces (if needed)
2. Core logic at the insertion point
3. Updated call sites (if any)
4. Tests — minimum one test per AC

Stay within the scope identified by `orient`. If you need to touch a function NOT in `$CANDIDATES`, re-run the gate for that function before proceeding.

---

## Step 9 — Verify

Run the test suite, then check spec drift:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>check_spec_drift</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

| Drift type | Resolution |
|---|---|
| `uncovered` on new files | Expected — propose `spec-gen generate` post-merge |
| `gap` on existing domain | Run `spec-gen generate --domains $DOMAIN` |
| `stale` | Fix the stale reference now |
| No drift | ✅ |

---

## Step 10 — Update the story

In the story file, fill in the **Dev Agent Record** section:

```markdown
## Dev Agent Record

### Brownfield Analysis

| Function | Risk Score | Strategy | Callers Protected |
|---|---|---|---|
| ... | ... | ... | ... |

### Implementation Summary

- **Insertion point**: `$FUNCTION` in `$TARGET_FILE`
- **Files changed**: [list]
- **Tests added**: N
- **Spec drift**: ✅ clean / ⚠️ [details]

### Scope Notes

All changes confined to functions identified by `orient`.
Functions deliberately excluded: [any relevant exclusions and why]
```

Mark the story status as `Review` (or your project's equivalent post-implementation status).

---

## Absolute Constraints

- Do not write code before Step 7 confirmation
- Do not touch functions outside `orient` scope without re-running the gate
- Do not skip `check_spec_drift`
- If risk score ≥ 70, stop — do not negotiate around the gate
