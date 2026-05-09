---
name: spec-gen-review-changes
description: Risk-aware code review using detect_changes + get_minimal_context + get_cluster. Surfaces the riskiest changed functions, interprets callType/coverage/cluster density, and produces a go/no-go recommendation. No code written.
license: MIT
compatibility: spec-gen MCP server
user-invocable: true
allowed-tools:
  - use_mcp_tool
  - ask_followup_question
---

# spec-gen: Review Changes

## When to use this skill

Trigger whenever the user asks to **review, audit, or check the safety of recent changes**:
- "review my changes"
- "what did I break?"
- "is this branch safe to merge?"
- "pre-PR check" / "what's risky in this diff?"
- explicit command `/spec-gen-review-changes`

**No code is written.** Output is a risk-ranked review with a go/no-go recommendation.

---

## Step 1 — Confirm directory and base ref

Ask: which project? Diff against which base? (default: `main`)

---

## Step 2 — Detect changed functions and risk scores

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>detect_changes</tool_name>
  <arguments>{"directory": "$DIRECTORY", "base": "$BASE_REF"}</arguments>
</use_mcp_tool>
```

Risk score is **multiplicative**: `likelihood × impact`.
- `likelihood` = changeScore × (1 + coveragePenalty) — `"called"` tests count full; `"imported"`-only count 0.3×
- `impact` = log(fanIn) + distance-weighted transitive callers (weighted by callType) + external boundary calls

Functions with fanIn=0 calling nothing external score 0 — correct; focus on non-zero scores.

Present a risk-ranked table:

| Rank | Function | File | riskScore | blastRadius | fanIn | testedBy |
|---|---|---|---|---|---|---|

Flag: `≥ 5` → 🔴 HIGH | `2–5` → 🟡 MEDIUM | `< 2` → 🟢 LOW

---

## Step 3 — Deep-inspect each HIGH function

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_minimal_context</tool_name>
  <arguments>{"directory": "$DIRECTORY", "functionName": "$FUNCTION_NAME"}</arguments>
</use_mcp_tool>
```

**What to read:**
- `function.riskLevel` — `"high"` means up to 24 callers/callees shown; all are in blast radius.
- `callers[*].callType` — all `"awaited"` = async interface frozen; signature change breaks all callers silently. Mixed = looser.
- `callees[*].isExternal: true` — external boundary; failures propagate past mocks.
- `testedBy[*].confidence` — `"called"` = strong. `"imported"` only = `vi.mock()` can neutralize; treat as untested.

State for each HIGH function:
```
$FUNCTION_NAME: interface frozen? | external boundary? | effective coverage | verdict
```

---

## Step 4 — Check cluster density for non-safe HIGH functions

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_cluster</tool_name>
  <arguments>{"directory": "$DIRECTORY", "functionName": "$FUNCTION_NAME"}</arguments>
</use_mcp_tool>
```

`stats.clusterDensity`:
- `< 0.05` → sparse; change isolated; safe to land independently
- `0.05–0.15` → moderate; review `internalCallGraph` for transitively dependent functions
- `> 0.15` → dense; coordinate whole cluster; consider feature flag or staged rollout

---

## Step 5 — Coverage gap check

For each HIGH/MEDIUM function with `testedBy` empty or all `"imported"`:
> "⚠️ `$FUNCTION_NAME` has no direct test coverage. Recommend a characterisation test before merging."

Suggest a concrete test scenario from the function body.

---

## Step 6 — Output

### Summary
Total changed: N | HIGH: N | MEDIUM: N | Coverage gaps: N

### Risk table (from Step 2)

### Function verdicts (HIGH only)

### Go / No-Go
- ✅ **Safe to merge** — no HIGH-risk uncovered functions
- ⚠️ **Merge with caution** — HIGH functions exist but covered by direct tests
- 🛑 **Do not merge** — HIGH uncovered functions with frozen interfaces or external boundaries

---

## Absolute constraints

- Never skip Step 3 for HIGH functions — riskScore alone is not enough
- `callType` determines whether interface change is breaking — always interpret it
- `"imported"` confidence is not strong coverage — always flag it
- Do not recommend merging: riskScore ≥ 5 + zero direct tests + external callee
