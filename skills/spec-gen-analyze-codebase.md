# SKILL: spec-gen — Analyze Codebase

## When to use this skill

Trigger this skill whenever the user asks to **analyze a codebase** with spec-gen, with phrasings like:
- "analyze my project / my code"
- "give me a code quality report"
- "what are the structural issues in my codebase"
- "find duplicates in my code"
- explicit command `/spec-gen-analyze-codebase`

This skill is **read-only** — it modifies no files. It produces a report and suggests next steps.

---

## Step 1 — Confirm the project directory

Ask the user which project to analyze, or confirm the current workspace root.

```
Which project directory should I analyze?
Options: current workspace root | enter a different path
```

---

## Step 2 — Run static analysis

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

---

## Step 3 — Get the architecture overview

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_architecture_overview</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

Present a concise summary:
- Total files, clusters, edges, cycles, and layer violations
- Top 3 clusters by file count: role (entry_layer / orchestrator / hub_heavy / internal) and dependsOn
- Global entry points — the public-facing roots of the codebase
- Critical hub functions (high fan-in — touch with care)

---

## Step 4 — Summarize the refactor report

Present a concise summary from the `analyze_codebase` result:
- Project type and detected frameworks
- File count, function count, internal call count
- Top 5 refactoring issues (function name, file, issue type, priority score)
- Detected domains

---

## Step 5 — Show the call graph

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_call_graph</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

Highlight:
- **Hub functions** (fanIn ≥ 8) — over-solicited functions, high coupling risk
- **Layer violations** detected (e.g. a UI layer calling the database directly)

---

## Step 6 — Show duplicate code report

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_duplicate_report</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

Present a concise summary:
- Overall duplication ratio (e.g. "12% of functions are duplicated")
- Top 3 clone groups sorted by impact (instances × line count):
  - Clone type (exact / structural / near) and similarity score
  - List of instances (file + function name + line range)
- If no duplicates found, note this as a positive signal

---

## Step 7 — Suggest next steps

Based on the analysis, guide the user through the natural next actions in order:

1. Call `get_signatures` on the modules containing the top issues to understand their public API
2. Call `get_subgraph` on the highest-priority function to map its callers and callees
3. Call `suggest_insertion_points` with a brief feature description to find where new logic should land — useful before starting any new work on this codebase
4. If significant duplication was found, suggest consolidating clone groups **before** refactoring
5. Suggest running `/spec-gen-plan-refactor` once the user has enough context to act, then `/spec-gen-execute-refactor` to apply the plan
6. If the project has OpenSpec specs:
   - Call `list_spec_domains` to discover available spec domains
   - Call `search_specs` to find requirements by intent — this enables spec-first reasoning
     (question → requirements → linked source files) rather than code-first exploration
   - Suggest `/spec-gen-implement-feature` for any new feature work
     (integrates specs + insertion points + drift check)
   - To enable `search_specs`, run `spec-gen analyze --embed` or `spec-gen analyze --reindex-specs`
     (requires the embedding server)

---

## Absolute constraints

- **No code modifications** in this workflow
- Never skip the duplication step — it determines the order of subsequent actions
- Always present architecture overview, call graph, and duplicate report even if numbers are low
- Next steps (Step 7) are suggestions, not automatic actions
