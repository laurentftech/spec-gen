# spec-gen: Refactor Codebase

Identify the highest-priority refactoring targets using static analysis, assess
the blast radius of each change, and propose concrete code edits — iterating
until the priority score drops.

## Step 1: Confirm the project directory

Ask the user which project to refactor, or confirm the current workspace root.

<ask_followup_question>
  <question>Which project directory should I refactor?</question>
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
Ask the user which one to tackle first, or pick the top one by default.

## Step 4: Assess impact before changing anything

For the chosen function, get the full impact analysis.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_impact</tool_name>
  <arguments>{"directory": "$DIRECTORY", "symbol": "$FUNCTION_NAME"}</arguments>
</use_mcp_tool>

Show:
- Risk score (0–100) and what it means
- Recommended strategy (extract / split / facade / delegate)
- How many callers depend on this function (upstream chain)

## Step 5: Visualise the call neighbourhood

Render the subgraph as a Mermaid diagram to map callers and callees.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_subgraph</tool_name>
  <arguments>{"directory": "$DIRECTORY", "functionName": "$FUNCTION_NAME", "direction": "both", "format": "mermaid"}</arguments>
</use_mcp_tool>

## Step 6: Find safe entry points

Identify low-risk functions to extract or rename first (bottom-up approach).

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_low_risk_refactor_candidates</tool_name>
  <arguments>{"directory": "$DIRECTORY", "limit": 5}</arguments>
</use_mcp_tool>

## Step 7: Propose concrete changes

Based on the recommended strategy from Step 4:

- **split**: list the sub-responsibilities to extract into separate functions,
  with suggested names derived from the domain vocabulary
- **extract**: identify helper logic that can become a standalone function
- **facade**: propose a thin wrapper that delegates to smaller functions
- **delegate**: identify which callers should own part of the current logic

Present the plan and ask for confirmation before writing any code.

## Step 8: Apply changes

Make the agreed code edits. Do not change observable behaviour — rename and
restructure only. Run existing tests after each change to confirm nothing broke.

## Step 9: Verify improvement

Re-analyse to confirm the priority score dropped for the refactored function.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$DIRECTORY", "force": true}</arguments>
</use_mcp_tool>

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_refactor_report</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Confirm that `withIssues` decreased and the function is no longer in the top list.
If not, investigate why and iterate.

## Step 10 (optional — requires spec-gen generate to have been run)

**Important**: this step proposes irreversible changes (deletions, renames).
Do not apply anything without explicit user confirmation at each sub-step.

### 10a. Dead code: orphan functions

Check for functions not covered by any spec requirement.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_mapping</tool_name>
  <arguments>{"directory": "$DIRECTORY", "orphansOnly": true}</arguments>
</use_mcp_tool>

Present the orphan list (kind `function` or `class` only). For each one, check:
- Is it exported and potentially consumed by external code?
- Is it re-exported from an index file?
- Was it simply missed by the LLM in Stage 3?

Only after the user has reviewed and confirmed each entry, propose deletion or
a documentation comment marking it as intentionally uncovered.

**Do not delete anything without the user explicitly approving each function.**

### 10b. Naming alignment: spec vocabulary vs actual names

Find functions whose names diverge from the business vocabulary in the spec.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_mapping</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Build a table of mismatches (requirement name vs function name) and present it
to the user for review before touching any code:

| Current name | Proposed name | File | Confidence |
|---|---|---|---|

Only renames with `confidence: "llm"` should be proposed automatically.
Flag `confidence: "heuristic"` entries for manual verification first.

**Wait for explicit user approval of the full rename table before applying
any change. Apply renames one file at a time and run tests after each.**
