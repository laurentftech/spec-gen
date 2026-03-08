# SKILL: spec-gen — Implement Feature

## When to use this skill

Trigger this skill whenever the user asks to **add a new feature** to an existing codebase, with phrasings like:
- "implement X in my project"
- "add a feature that does Y"
- "where should I add this new functionality"
- "help me implement this feature without breaking the architecture"
- explicit command `/spec-gen-implement-feature`

This skill combines static analysis (architecture overview, insertion points) with OpenSpec
requirements and a post-implementation drift check. **No code is written until Step 6.**

---

## Step 1 — Confirm the project directory and feature description

Ask the user:
```
Which project directory? And describe the feature in 1–3 sentences.
Options: current workspace root | enter a different path
```

Store the feature description as `$FEATURE_DESCRIPTION`.

---

## Step 2 — Get the architecture overview

Orient yourself before touching any code.

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_architecture_overview</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

If the result contains `{ "error": "..." }`, run `analyze_codebase` first, then retry.

From the result, identify:
- Which cluster(s) the feature most likely belongs to (by role and name)
- Critical hub functions to avoid touching unnecessarily (high fan-in = high blast radius)
- Existing entry points the feature may need to hook into

---

## Step 3 — Search the OpenSpec specifications (if available)

Discover which spec domains exist, then search for requirements relevant to the feature.

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>list_spec_domains</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

If domains are found, search the specs semantically:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>search_specs</tool_name>
  <arguments>{"directory": "$DIRECTORY", "query": "$FEATURE_DESCRIPTION", "limit": 5}</arguments>
</use_mcp_tool>
```

From the results, extract:
- Existing requirements that relate to the feature (note their `id` for drift tracking)
- Any constraints or acceptance criteria already documented
- The `linkedFiles` — these are the source files already mapped to those requirements

If `search_specs` returns an index-not-found error, fall back to reading the spec file
directly: `openspec/specs/<domain>/spec.md`.

If no spec exists yet, note it — the feature will be flagged as `uncovered` by `check_spec_drift`
after implementation. That is expected; propose running `spec-gen generate` after the feature lands.

---

## Step 4 — Find insertion points

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>suggest_insertion_points</tool_name>
  <arguments>{"directory": "$DIRECTORY", "query": "$FEATURE_DESCRIPTION", "limit": 5}</arguments>
</use_mcp_tool>
```

For each candidate, present: rank, name, file, role, strategy, reason.
Note whether it belongs to the cluster identified in Step 2.

Then inspect the top candidate's call neighbourhood:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_subgraph</tool_name>
  <arguments>{"directory": "$DIRECTORY", "functionName": "$TOP_CANDIDATE", "direction": "both", "format": "mermaid"}</arguments>
</use_mcp_tool>
```

Show the Mermaid diagram and ask the user to confirm the chosen insertion point.

---

## Step 5 — Read the skeleton of the target file

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_function_skeleton</tool_name>
  <arguments>{"directory": "$DIRECTORY", "filePath": "$TARGET_FILE"}</arguments>
</use_mcp_tool>
```

Use the skeleton to identify the exact insertion location and existing patterns to follow.

**Ask the user to confirm the implementation approach before writing any code:**
> "I plan to [extend / add / hook into] `$TOP_CANDIDATE` in `$TARGET_FILE` by [brief description]. Does this match your intent?"

---

## Step 6 — Implement the feature

Apply changes incrementally:

1. **Add new types / interfaces** (if needed)
2. **Implement core logic** at the chosen insertion point
3. **Update call sites** if the insertion requires it
4. **Add or update tests** — at minimum one test covering the new behaviour
5. **Run the test suite** to confirm nothing is broken

Follow the existing code style observed in the Step 5 skeleton.

---

## Step 7 — Check spec drift

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>check_spec_drift</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

- **uncovered** issues on new files: expected if no spec existed — offer to run `spec-gen generate`
- **gap** issues on existing specs: new code changed a covered domain's API — run `spec-gen generate --domains $DOMAIN`
- **No drift**: ✅ All changed files are covered by up-to-date specs

---

## Step 8 — Summarise

Present:
- **Feature**: $FEATURE_DESCRIPTION
- **Files changed**: list with line counts
- **Insertion point**: $TOP_CANDIDATE in $TARGET_FILE (role: $ROLE, strategy: $STRATEGY)
- **Tests**: N added / N updated
- **Spec drift**: ✅ clean / ⚠️ N issues (remediation: …)

Suggest follow-up actions if applicable:
- Regenerate specs (`spec-gen generate`)
- Re-run analysis (`analyze_codebase`) to update the call graph
- If the feature touched a hub function, suggest `/spec-gen-plan-refactor` to track growing complexity

---

## Absolute constraints

- **No code written before Step 6** — analysis and user confirmation come first
- Always confirm the insertion point with the user before implementing
- Run tests after implementation — never skip
- Run `check_spec_drift` as the final verification step
