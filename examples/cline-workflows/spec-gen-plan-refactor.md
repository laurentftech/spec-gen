# spec-gen: Plan Refactor

Identify the highest-priority refactoring target using static analysis, assess
its blast radius, and produce a detailed written plan — saved to
`.spec-gen/refactor-plan.md` — that `/spec-gen-execute-refactor` can follow
step by step without losing context.

This workflow makes **no code changes**. It only reads and writes the plan file.

## Step 1: Confirm the project directory

Ask the user which project to analyse, or confirm the current workspace root.

<ask_followup_question>
  <question>Which project directory should I plan the refactor for?</question>
  <options>["Current workspace root", "Enter a different path"]</options>
</ask_followup_question>

## Step 2: Run static analysis

Analyse the project. If analysis already ran recently, skip unless the user
requests a fresh run.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

## Step 3: Get the full refactoring report

Retrieve the prioritised list of functions with structural issues.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_refactor_report</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Present the top 5 candidates in a table: function, file, issues, priority score.

## Step 3b: Check for duplicate code (optional enrichment)

Call `get_duplicate_report` to surface clones that overlap with the top candidates.
If the target function (or any callee) appears in a clone group, note it in the plan:
consolidated duplicates reduce blast radius before extracting logic.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_duplicate_report</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

If a top candidate appears in a clone group, prepend a **Deduplication note** to the plan:
> "⚠️ `<function>` has N near-clones. Consolidate them first to reduce the blast radius
> of this refactor."

Before asking the user to pick a target, **check test coverage for the files
containing the top candidates**. Detect the coverage tool from the project
(look for `package.json` scripts, `pytest.ini`, `Cargo.toml`, `go.mod`, etc.)
and run it scoped to those files only:

- Node.js → `npm test -- --coverage --collectCoverageFrom="<files>"`
- Python  → `pytest --cov=<module> --cov-report=term-missing`
- Rust    → `cargo tarpaulin --include-files <files>`
- Go      → `go test -cover ./...` (filter relevant packages)

For each candidate file, present a compact coverage badge:

| Function | File | Priority | Coverage |
|---|---|---|---|
| ... | ... | ... | 72% ✅ / 35% ⚠️ / 0% 🚫 |

Apply these thresholds to annotate each row:

| Coverage | Badge | Meaning |
|---|---|---|
| ≥ 70% lines | ✅ | Safe to refactor |
| 40–69% lines | ⚠️ | Write characterisation tests first |
| < 40% lines | 🛑 | Strongly discouraged — recommend tests first |
| 0% (no tests) | 🚫 | Blocked — propose a test harness before proceeding |

If **all top candidates are below 40%**, tell the user:
> "Every high-priority target has insufficient test coverage (< 40%). Refactoring
> without tests risks introducing silent regressions. I recommend writing a
> minimal test harness for at least one target before proceeding. Would you like
> me to suggest test cases based on the function signatures?"

Then ask the user which one to tackle first, or pick the top one by default.
Prefer candidates with higher coverage when scores are otherwise close.

## Step 4: Assess impact

First, get condensed view (callers, callees, body, test coverage in one call):

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_minimal_context</tool_name>
  <arguments>{"directory": "$DIRECTORY", "functionName": "$FUNCTION_NAME"}</arguments>
</use_mcp_tool>

Then get the full impact analysis:

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_impact</tool_name>
  <arguments>{"directory": "$DIRECTORY", "symbol": "$FUNCTION_NAME"}</arguments>
</use_mcp_tool>

Note:
- Risk score (0–100) and what it means
- Recommended strategy (extract / split / facade / delegate)
- Upstream callers and downstream callees (keep the top 5 of each for the plan)

## Step 5: Visualise the call neighbourhood

Render the subgraph to map callers and callees precisely.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_subgraph</tool_name>
  <arguments>{"directory": "$DIRECTORY", "functionName": "$FUNCTION_NAME", "direction": "both", "format": "mermaid"}</arguments>
</use_mcp_tool>

Show the Mermaid diagram to the user.

## Step 6: Find safe entry points

Identify low-risk leaf functions that can be extracted first (bottom-up).

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_low_risk_refactor_candidates</tool_name>
  <arguments>{"directory": "$DIRECTORY", "filePattern": "$TARGET_FILE", "limit": 5}</arguments>
</use_mcp_tool>

Cross-reference with the subgraph from Step 5: a candidate is a good first
extraction if it already appears as a callee of the target function.

## Step 6b: Find insertion points for extracted helpers

Before designing the change sequence, identify where extracted functions should land.
This avoids creating helpers in the wrong file or layer.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>suggest_insertion_points</tool_name>
  <arguments>{"directory": "$DIRECTORY", "query": "extract helper from $FUNCTION_NAME", "limit": 5}</arguments>
</use_mcp_tool>

For each candidate returned, note its role (entry_point / orchestrator / hub / utility / internal)
and the suggested strategy. Cross-reference with the subgraph from Step 5: prefer candidates
that already call into — or are called by — the target function.

## Step 7: Design the change sequence

Based on the recommended strategy from Step 4, design an ordered sequence of
atomic changes. Each change must specify:

- **What**: the exact block of logic to move (line range or description)
- **New name**: the function or method name to give it
- **Target file**: the file where it will live after the move
  - If the logic belongs to an existing module: name that file
  - If no suitable module exists: propose a new file path (e.g.
    `src/services/validation.ts`) and justify the choice
- **Target class** (if applicable): the class or namespace to place it in
- **Callers to update**: list every call site that will need updating

For each strategy, apply these rules:

- **split**: decompose the function into N sub-functions; each sub-function
  stays in the same file unless it clearly belongs elsewhere
- **extract**: pull out a helper; place it in the nearest cohesive module or
  create a new file if none exists
- **facade**: keep the original signature, delegate body to smaller functions;
  create a private companion module if the file would exceed 300 lines
- **delegate**: move ownership logic to callers; update each caller file listed
  in the upstream chain

Present the full change sequence to the user for review and ask for confirmation
before writing the plan file.

## Step 8: Write the plan file

Create `.spec-gen/refactor-plan.md` in the project directory with the following
structure (fill every section — leave nothing as "TBD"):

```markdown
# Refactor Plan

Generated: <ISO date>
Workflow: /spec-gen-plan-refactor → /spec-gen-execute-refactor

## Target

- **Function**: <name>
- **File**: <relative path>
- **Lines**: <start>–<end>  (read the file to confirm)
- **Risk score**: <0–100>
- **Strategy**: <extract | split | facade | delegate>
- **Priority score before refactor**: <value>

## Why

- <issue 1 from refactor report>
- <issue 2>
- ...

## Callers (upstream — must not break)

| Caller | File |
|---|---|
| <name> | <path> |

## Callees (downstream — candidates for extraction)

| Callee | File |
|---|---|
| <name> | <path> |

## Coverage baseline

- **File**: <target file>
- **Coverage**: <X>% lines, <Y>% branches
- **Status**: ✅ safe / ⚠️ caution / 🛑 discouraged
- **Test command**: <exact command to run>

## Change sequence

Apply in order. Do not skip ahead. Run tests after each step.

### Change 1 — <short label>

- **What**: extract lines <start>–<end> (logic: <one-line description>)
- **New function name**: `<name>`
- **Target file**: `<path>` (<new file | existing file — reason>)
- **Target class**: `<ClassName>` or none
- **Call sites to update**: <list each file:line>
- **Expected diff**: +<N> lines in <new/existing file>, -<M> lines in <source file>

### Change 2 — <short label>

...

## Acceptance criteria

- Priority score drops below <target score> in `get_refactor_report`
- Function exits the top-5 list
- Full test suite passes (green)
- `git diff --stat` shows only the expected files

## Restore point

Run before starting execute:
```bash
git log --oneline -1
```
Note the hash here: <to be filled by execute workflow>
```

Once the file is written, record the refactoring decision so it appears in the decisions workflow at commit time:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>record_decision</tool_name>
  <arguments>{
    "directory": "$DIRECTORY",
    "title": "Refactor $TARGET_FUNCTION into smaller units ($STRATEGY)",
    "rationale": "$PRIMARY_REASON from the Why section above",
    "consequences": "Callers unchanged; complexity distributed across $N extracted helpers",
    "affectedFiles": ["$TARGET_FILE"]
  }</arguments>
</use_mcp_tool>
```

Then tell the user:
> "Plan written to `.spec-gen/refactor-plan.md`. Review it, then run
> `/spec-gen-execute-refactor` to apply the changes."
