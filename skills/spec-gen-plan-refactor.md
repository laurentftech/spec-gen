# SKILL: spec-gen — Plan Refactor

## When to use this skill

Trigger this skill whenever the user asks to **plan a refactoring** on a codebase, with phrasings like:
- "plan a refactoring of X"
- "analyze my code and prepare a refactor plan"
- "generate a refactoring plan"
- "I want to refactor this function / this file"
- explicit command `/spec-gen-plan-refactor`

**This skill modifies no code files.** It only produces `.spec-gen/refactor-plan.md`.
To apply the plan, use the `spec-gen-execute-refactor` skill.

---

## User-specified target — shortcut path

If the user has already named a specific file or function to refactor:
- **Skip** Steps 2, 3, and 3b (discovery is not needed).
- **Do not skip** Steps 3c, 4, 5, 6, and 6b — coverage check and impact analysis are mandatory regardless of how the target was chosen.
- Jump directly to Step 3c using the user-provided target.

---

## Step 1 — Confirm the project directory

Ask the user which project to analyze, or confirm the current workspace root.

---

## Step 2 — Run static analysis

Analyze the project via the `spec-gen` MCP server. If a recent analysis already exists, skip unless the user explicitly requests a fresh run.

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

---

## Step 3 — Get the refactoring report

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_refactor_report</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

Present the top 5 candidates:

| Function | File | Issues | Priority score |
|---|---|---|---|

---

## Step 3b — Check for duplicate code

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_duplicate_report</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

If a top candidate appears in a clone group, prepend a **deduplication note** to the plan:
> "⚠️ `<function>` has N near-clones. Consolidate them first to reduce the blast radius of this refactor."

---

## Step 3c — Check test coverage

Before presenting a choice to the user, check test coverage for the files containing the candidates. Detect the coverage tool from the project:

| Ecosystem | Command |
|---|---|
| Node.js | `npm test -- --coverage --collectCoverageFrom="<files>"` |
| Python | `pytest --cov=<module> --cov-report=term-missing` |
| Rust | `cargo tarpaulin --include-files <files>` |
| Go | `go test -cover ./...` |

Enrich the candidate table:

| Function | File | Priority | Coverage |
|---|---|---|---|
| ... | ... | ... | 72% ✅ / 35% ⚠️ / 0% 🚫 |

**Thresholds:**

| Coverage | Badge | Meaning |
|---|---|---|
| ≥ 70% lines | ✅ | Safe to refactor |
| 40–69% lines | ⚠️ | Write characterisation tests first |
| < 40% lines | 🛑 | Strongly discouraged |
| 0% (no tests) | 🚫 | Blocked — propose a test harness first |

If **all candidates are below 40%**:
> "Every high-priority target has insufficient test coverage (< 40%). I recommend writing a minimal test harness for at least one target before proceeding. Would you like me to suggest test cases based on the function signatures?"

---

## Step 4 — Analyze impact

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_impact</tool_name>
  <arguments>{"directory": "$DIRECTORY", "symbol": "$FUNCTION_NAME"}</arguments>
</use_mcp_tool>
```

Note: risk score (0–100), recommended strategy (`extract` / `split` / `facade` / `delegate`), top 5 upstream callers and downstream callees.

---

## Step 5 — Visualise the call neighbourhood

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_subgraph</tool_name>
  <arguments>{"directory": "$DIRECTORY", "functionName": "$FUNCTION_NAME", "direction": "both", "format": "mermaid"}</arguments>
</use_mcp_tool>
```

Show the Mermaid diagram to the user.

---

## Step 6 — Find safe entry points (bottom-up)

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_low_risk_refactor_candidates</tool_name>
  <arguments>{"directory": "$DIRECTORY", "filePattern": "$TARGET_FILE", "limit": 5}</arguments>
</use_mcp_tool>
```

Cross-reference with the subgraph from Step 5: a good first extraction candidate already appears as a callee of the target function.

---

## Step 6b — Find insertion points for extracted helpers

Before designing the change sequence, identify where extracted functions should land.
This avoids creating helpers in the wrong file or layer.

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>suggest_insertion_points</tool_name>
  <arguments>{"directory": "$DIRECTORY", "query": "extract helper from $FUNCTION_NAME", "limit": 5}</arguments>
</use_mcp_tool>
```

For each candidate, note its role and strategy. Prefer candidates that already call into — or are called by — the target function (visible in the Step 5 subgraph).

---

## Step 7 — Design the change sequence

Design an ordered sequence of atomic changes based on the strategy from Step 4.

**Each change is a complete unit: edit → verify diff → run tests → mark done. Tests are not a final gate; they are a mandatory sub-step after every single change. Write the plan to reflect this explicitly.**

Each change must specify:

- **What**: the exact block to move (line range or description)
- **New name**: the function or method name to give it
- **Target file**: existing or new file (with justification)
- **Target class** (if applicable)
- **Call sites to update**: list each `file:line`

**Rules per strategy:**

| Strategy | Rule |
|---|---|
| `split` | Decompose into N sub-functions in the same file unless they clearly belong elsewhere |
| `extract` | Place in the nearest cohesive module or create a new file if none exists |
| `facade` | Keep the original signature, delegate to smaller functions; companion module if > 300 lines |
| `delegate` | Move ownership logic to callers; update every caller file in the upstream chain |

**Present the full sequence and wait for confirmation before writing the plan file.**

---

## Step 8 — Write `.spec-gen/refactor-plan.md`

Fill every section — **leave nothing as "TBD"**.

```markdown
# Refactor Plan

Generated: <ISO date>
Workflow: /spec-gen-plan-refactor → /spec-gen-execute-refactor

## Target
- **Function**: <name>
- **File**: <relative path>
- **Lines**: <start>–<end>
- **Risk score**: <0–100>
- **Strategy**: <extract | split | facade | delegate>
- **Priority score before refactor**: <value>

## Why
- <issue 1>
- <issue 2>

## Callers (upstream — must not break)
| Caller | File |
|---|---|

## Callees (downstream — candidates for extraction)
| Callee | File |
|---|---|

## Coverage baseline
- **File**: <target file>
- **Coverage**: <X>% lines, <Y>% branches
- **Status**: ✅ safe / ⚠️ caution / 🛑 discouraged
- **Test command**: <exact command>

## Change sequence
Apply in order. Run tests after each step.

### Change 1 — <short label>
- **What**: extract lines <start>–<end> (logic: <one-line description>)
- **New function name**: `<name>`
- **Target file**: `<path>` (<new file | existing file — reason>)
- **Target class**: `<ClassName>` or none
- **Call sites to update**: <list each file:line>
- **Expected diff**: +<N> lines in <target file>, -<M> lines in <source file>

### Change 2 — <short label>
...

## Acceptance criteria
- Priority score drops below <target score> in `get_refactor_report`
- Function exits the top-5 list
- Full test suite passes (green)
- `git diff --stat` shows only the expected files

## Restore point
Hash: <to be filled by the execute workflow>
```

Once the file is written:
> "Plan written to `.spec-gen/refactor-plan.md`. Review it, then run `/spec-gen-execute-refactor` to apply the changes."

---

## Absolute constraints

- **No code modifications** in this workflow
- Always read the source file to confirm exact line numbers
- Never leave a section empty or as "TBD"
- Prefer candidates with higher coverage when scores are otherwise close
- If the user does not pick a target, default to the top candidate
