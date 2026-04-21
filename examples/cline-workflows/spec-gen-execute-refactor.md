# spec-gen: Execute Refactor

Apply the refactoring plan produced by `/spec-gen-plan-refactor`. This workflow
reads `.spec-gen/refactor-plan.md` at the start and re-reads it before each
change to stay on track — especially important with small or limited models.

**Prerequisites**: run `/spec-gen-plan-refactor` first and confirm the plan.

## Step 1: Read the plan

Read `.spec-gen/refactor-plan.md` from the project directory.

If the file does not exist, stop immediately:
> "No refactor plan found at `.spec-gen/refactor-plan.md`. Please run
> `/spec-gen-plan-refactor` first to generate a plan."

Extract and display a summary:
- Target function, file, and line range
- Strategy and risk score
- Number of changes planned
- Test command
- Acceptance criteria

Ask the user to confirm before proceeding.

## Step 2: Establish a green baseline

Confirm the test suite is passing. Use the test command from the plan.

**If tests are already failing, stop and tell the user.** Do not proceed with
refactoring on a red baseline — the failures must be fixed first or the user
must explicitly acknowledge them.

If a coverage tool is available, run it on the target file and compare against
the coverage baseline in the plan.

| Coverage on files to touch | Recommendation |
|---|---|
| ≥ 70% lines | Safe to refactor — proceed |
| 40–69% lines | Caution — write characterisation tests for the affected functions before starting |
| < 40% lines | **Stop.** Strongly recommend writing tests first. Refactoring untested code hides regressions. |
| 0% (no tests at all) | **Block.** Do not refactor. Propose writing a minimal test harness first, then restart the workflow. |

If coverage is below 40%, tell the user:
> "Coverage on the target file is X%. Refactoring without test coverage risks
> introducing silent regressions. I recommend writing tests for the affected
> functions before proceeding. Would you like me to suggest test cases based on
> the function signatures, or do you want to proceed at your own risk?"

Only continue past this point with explicit user confirmation.

**Large file warning**: If the target function spans more than 300 lines:
> "This function is X lines long. Small models (< 13B parameters) may lose
> code when editing files of this size in a single pass. Recommended approach:
> apply Change 1 from the plan (smallest extraction) first to reduce the target
> below 200 lines before the main refactor."

## Step 3: Set the restore point

Verify the working tree is clean, then note the restore point:

```bash
git status            # must show: nothing to commit, working tree clean
git log --oneline -1  # note this commit hash — your restore point
```

If there are uncommitted changes, stop and ask the user to commit or stash them
first. A clean tree guarantees that `git checkout HEAD -- <file>` will fully
restore any file to its pre-edit state.

Fill in the `Restore point` section of `.spec-gen/refactor-plan.md` with the
current commit hash.

## Step 4: Apply changes (one at a time)

Before applying the first change, record the refactoring decision:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>record_decision</tool_name>
  <arguments>{
    "directory": "$DIRECTORY",
    "title": "Refactor $TARGET_FUNCTION via $STRATEGY",
    "rationale": "$PRIMARY_REASON from the plan's Why section",
    "consequences": "Callers unchanged; complexity distributed across extracted helpers",
    "affectedFiles": ["$TARGET_FILE"]
  }</arguments>
</use_mcp_tool>
```

Also call `record_decision` for any unexpected architectural choice that emerges mid-refactor (new module boundary discovered, shared interface change required, dependency introduced).

**Before each change**, re-read `.spec-gen/refactor-plan.md` to confirm:
- Which change you are on
- Exactly what to extract, where to put it, and which call sites to update

**Editing tool rule**: Always prefer a targeted edit tool (`replace_in_file`,
`str_replace_based_edit`, `apply_diff`, or equivalent) over a full-file
rewrite tool (`write_to_file`). Only use `write_to_file` if the file is under
100 lines in total. If a change seems to require `write_to_file` on a larger
file, stop and split it into smaller targeted edits instead.

**Model capability note**: If using a small model (Mistral Small, Phi, Gemma,
or any model under 13B parameters), enforce an additional constraint: each edit
must touch a contiguous block of at most 50 lines. If the intended change
exceeds this, split it into multiple smaller extractions and apply them one
by one.

For each change in the plan:

1. **Read the source file** around the lines to extract (do not rely on memory).

2. **Apply the edit**:
   - Extract or move the identified block
   - Place it in the target file and target class specified in the plan
   - If the target file is new, create it with only the extracted code
   - Update all call sites listed in the plan

3. **Verify the diff** before running tests:
   ```bash
   git diff --stat   # only the expected files should appear
   git diff          # scan deleted lines (-) and confirm each removal is
                     # intentional — moved to a new function or file,
                     # not silently dropped.
                     # If deleted lines >> added lines with no new file
                     # created, code was likely lost — abort immediately.
   ```

4. **Run the test suite** (use the command from the plan). If any test fails,
   restore the file right away:
   ```bash
   git checkout HEAD -- <file>
   ```
   Do NOT accumulate broken state before restoring.

5. **Mark the change as done** in `.spec-gen/refactor-plan.md` by appending
   `✅` to the change heading, then proceed to the next one.

Repeat until all changes in the plan are marked ✅.

## Step 5: Verify improvement

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

Check each acceptance criterion from the plan:
- Priority score dropped below the target
- Function is no longer in the top-5 list
- Full test suite passes

If not, investigate why and iterate (add a new change to the plan if needed).

Run the full test suite one final time to confirm the refactored state is clean.

## Step 6 (optional — requires spec-gen generate to have been run)

**Important**: this step proposes irreversible changes (deletions, renames).
Do not apply anything without explicit user confirmation at each sub-step.

### 6a. Dead code: orphan functions

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

### 6b. Naming alignment: spec vocabulary vs actual names

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
