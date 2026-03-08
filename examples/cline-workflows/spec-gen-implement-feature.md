# spec-gen: Implement Feature

Plan and implement a new feature with full architectural context:
architecture overview → OpenSpec requirements → insertion points → implementation → drift check.

No code is written until Step 6. Steps 1–5 are read-only analysis.

## Step 1: Get the project directory and feature description

Ask the user:

<ask_followup_question>
  <question>Which project directory and what feature should I implement?</question>
  <options>["Current workspace root", "Enter a different path"]</options>
</ask_followup_question>

Also ask for a brief description of the feature if not already provided (1–3 sentences).
Store it as `$FEATURE_DESCRIPTION`.

## Step 2: Get the architecture overview

Orient yourself before touching any code.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_architecture_overview</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

From the result, note:
- Which cluster(s) the feature most likely belongs to (based on role and name)
- Critical hub functions to avoid touching unnecessarily (high fan-in → high blast radius)
- Existing entry points — the feature may need to hook in at one of them

If analysis data is missing (`{ "error": "..." }`), run `analyze_codebase` first:

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

Then retry `get_architecture_overview`.

## Step 3: Search the OpenSpec specifications (if available)

Discover which spec domains exist, then search for requirements relevant to the feature.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>list_spec_domains</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

If domains are found, search the specs semantically:

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>search_specs</tool_name>
  <arguments>{"directory": "$DIRECTORY", "query": "$FEATURE_DESCRIPTION", "limit": 5}</arguments>
</use_mcp_tool>

From the results, extract:
- Existing requirements that relate to the feature (note their `id` for drift tracking)
- Any constraints or acceptance criteria already documented
- The `linkedFiles` — these are the source files already mapped to those requirements
  (will be highlighted in the diagram viewer)

If `search_specs` returns an index-not-found error, fall back to reading the spec file
directly: `openspec/specs/<domain>/spec.md`.

If no spec exists yet, note it — the feature will be "uncovered" and `check_spec_drift`
will flag it after implementation. That is expected: propose running `spec-gen generate`
after the feature lands.

## Step 4: Find insertion points

Identify the best functions and files to extend or hook into.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>suggest_insertion_points</tool_name>
  <arguments>{"directory": "$DIRECTORY", "query": "$FEATURE_DESCRIPTION", "limit": 5}</arguments>
</use_mcp_tool>

For each candidate, present:
- Rank, name, file, role, strategy, reason
- Whether it appears in the relevant cluster identified in Step 2

Then pick the top 1–2 candidates and inspect their call neighbourhood:

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_subgraph</tool_name>
  <arguments>{"directory": "$DIRECTORY", "functionName": "$TOP_CANDIDATE", "direction": "both", "format": "mermaid"}</arguments>
</use_mcp_tool>

Show the Mermaid diagram so the user can confirm the chosen insertion point is correct.

## Step 5: Read the skeleton of the target file(s)

Get a noise-stripped structural view of the file(s) you will modify.

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_function_skeleton</tool_name>
  <arguments>{"directory": "$DIRECTORY", "filePath": "$TARGET_FILE"}</arguments>
</use_mcp_tool>

Use the skeleton to:
- Confirm the insertion strategy (extend existing function vs. add new function)
- Identify the exact line range where new code will be added
- Spot any existing error handling or type patterns to follow

Ask the user to confirm the implementation approach before writing any code:

> "I plan to [extend / add / hook into] `$TOP_CANDIDATE` in `$TARGET_FILE` by [brief description].
> Does this match your intent?"

## Step 6: Implement the feature

Apply the changes incrementally:

1. **Add new types / interfaces first** (if needed) — separate commit
2. **Implement the core logic** at the chosen insertion point
3. **Update callers** if the insertion requires updating call sites
4. **Add or update tests** — at minimum one test covering the new behaviour
5. **Run the test suite** to confirm nothing is broken

Follow existing code style (naming conventions, error handling, import style) observed
in the skeleton from Step 5.

## Step 7: Check spec drift

After implementing, verify the feature is covered by specs (or flag missing coverage).

<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>check_spec_drift</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

### If drift is detected

Present the issues table (see `/spec-gen-check-spec-drift` for format).

For `uncovered` issues on the new files: this is expected if no spec existed.
Offer to run `spec-gen generate` to create/update the spec:

> "The new file `$NEW_FILE` has no matching spec. Run `spec-gen generate` to infer
> one from the implementation, or edit the spec manually if the domain spec already
> partially covers it."

For `gap` issues on existing specs: the new code changed the public API of a covered
domain. Run `spec-gen generate --domains $DOMAIN` to regenerate.

### If no drift

> ✅ All changed files are covered by up-to-date specs.

## Step 8: Summarise

Present a brief implementation summary:

- **Feature**: $FEATURE_DESCRIPTION
- **Files changed**: list with line counts
- **Insertion point**: $TOP_CANDIDATE in $TARGET_FILE (role: $ROLE, strategy: $STRATEGY)
- **Tests**: N added / N updated
- **Spec drift**: ✅ clean / ⚠️ N issues (remediation: …)

Suggest follow-up actions if applicable:
- Regenerate specs (`spec-gen generate`)
- Re-run analysis to update call graph (`analyze_codebase`)
- If the feature touches a hub function, suggest `/spec-gen-plan-refactor` to
  track growing complexity
