---
name: spec-gen-analyze-codebase
description: Run a full static analysis of a project using spec-gen and summarise the results — architecture, call graph, top refactoring issues, and duplicate code. No LLM required.
license: MIT
compatibility: spec-gen MCP server
user-invocable: true
allowed-tools:
  - ask_followup_question
  - use_mcp_tool
  - spec-gen-plan-refactor
---

# spec-gen: Analyze Codebase

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

## Step 3 — Summarize the results

Present a concise summary:
- Project type and detected frameworks
- File count, function count, internal call count
- Top 5 refactoring issues (function name, file, issue type, priority score)
- Detected domains

---

## Step 4 — Show the call graph

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

## Step 5 — Show duplicate code report

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

## Step 6 — Suggest next steps

Based on the analysis, guide the user through the natural next actions in order:

1. Call `get_signatures` on the modules containing the top issues to understand their public API
2. Call `get_subgraph` on the highest-priority function to map its callers and callees
3. If significant duplication was found, suggest consolidating clone groups **before** refactoring
4. Suggest running `/spec-gen-plan-refactor` once the user has enough context to act, then `/spec-gen-execute-refactor` to apply the plan
5. If the project has OpenSpec specs, call `list_spec_domains` then `search_specs` to enable
   spec-first reasoning (question → requirements → linked source files). To activate `search_specs`,
   run `spec-gen analyze --embed` or `spec-gen analyze --reindex-specs`.

---

## Absolute constraints

- **No code modifications** in this workflow
- Never skip the duplication step — it determines the order of subsequent actions
- Always present call graph and duplicate report results even if numbers are low
- Next steps (Step 6) are suggestions, not automatic actions
