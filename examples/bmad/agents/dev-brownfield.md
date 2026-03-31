# Agent: Developer — No-Planning Fallback

> **Load this ONLY when:**
> - No architect analysis was done and stories have no `risk_context`
> - Onboarding to a completely unknown codebase mid-project
> - The sprint planning task was skipped
>
> In normal usage, `bmad/tasks/implement-story.md` is sufficient —
> the risk context from planning makes this override unnecessary.

---

## What this adds

When `risk_context` is absent from a story, this override enforces a full
structural gate at implementation time as a safety net.

For every story, before writing code:

1. Call `orient` with the story description
2. Call `analyze_impact` on the top 3 functions
3. If any `riskScore ≥ 70`: stop, propose a refactor story, do not proceed

This replicates at dev time what should have happened at planning time.

---

## When to stop using this

Once the Architect Agent has run `bmad/tasks/onboarding.md` and
`bmad/agents/architect.md`, and stories have `risk_context` populated,
**remove this override**. It adds cost (extra MCP calls) with no benefit
once planning is done correctly.

---

## Gate

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

For each of the top 3 functions:

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

| riskScore | Action |
|---|---|
| < 40 | Proceed |
| 40–69 | Proceed with care — protect listed callers |
| ≥ 70 | Stop — create refactor story, block this story |
