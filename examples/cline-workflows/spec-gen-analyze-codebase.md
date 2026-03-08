# spec-gen: Analyze Codebase

Run a full static analysis of a project using spec-gen and summarise the results:
architecture, call graph, top refactoring issues, and duplicate code — no LLM required.

## Step 1: Get the project directory

Ask the user which project to analyse, or confirm we should use the current workspace root.

<ask_followup_question>
  <question>Which project directory should I analyse?</question>
  <options>["Current workspace root", "Enter a different path"]</options>
</ask_followup_question>

## Step 2: Run static analysis

Call analyze_codebase on the chosen directory.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

## Step 3: Get the architecture overview

Retrieve the high-level architecture map: clusters, cross-cluster dependencies,
entry points, and critical hub functions. This is the fastest way to orient
yourself before diving into details.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_architecture_overview</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Present a concise summary:
- Total files, clusters, edges, cycles, and layer violations
- Top 3 clusters sorted by file count, with their role (entry_layer / orchestrator /
  hub_heavy / internal) and which clusters they depend on
- Global entry points (the public-facing roots of the codebase)
- Critical hub functions (high fan-in — touch with care)

## Step 4: Summarise the refactor report

Present a concise summary:
- Project type and detected frameworks
- File count, function count, internal call count
- Top 5 refactoring issues (function name, file, issue type, priority score)
- Detected domains

## Step 5: Show the call graph

Retrieve hub functions, entry points, and any layer violations.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_call_graph</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Highlight any hub functions (fanIn ≥ 8) or layer violations detected.

## Step 6: Show duplicate code report

Retrieve the duplicate function analysis (Types 1–3, pure static analysis).

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_duplicate_report</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Present a concise summary:
- Overall duplication ratio (e.g. "12% of functions are duplicated")
- Top 3 clone groups sorted by impact (instances × line count):
  - Clone type (exact / structural / near) and similarity score
  - List of instances (file + function name + line range)
- If no duplicates found, note this as a positive signal

## Step 7: Suggest next steps

Based on the analysis, guide the user through the natural next steps in order:
1. Call `get_signatures` on the modules that contain the top issues to understand their public API
2. Call `get_subgraph` on the highest-priority function to map its callers and callees
3. Call `suggest_insertion_points` with a brief feature description to find where new
   logic should land — useful before starting any new work on this codebase
4. If significant duplication was found, suggest consolidating clone groups before refactoring
5. Suggest running `/spec-gen-plan-refactor` once the user has enough context to act,
   then `/spec-gen-execute-refactor` to apply the plan
6. If the project has OpenSpec specs:
   - Call `list_spec_domains` to discover available spec domains
   - Call `search_specs` to find requirements by intent — this enables spec-first reasoning
     (question → requirements → linked source files) rather than code-first exploration
   - Suggest `/spec-gen-implement-feature` for any new feature work
     (integrates specs + insertion points + drift check)
   - To enable `search_specs`, run `spec-gen analyze --embed` or `spec-gen analyze --reindex-specs`
     (requires the embedding server)
