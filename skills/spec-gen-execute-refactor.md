# SKILL: spec-gen — Execute Refactor

## When to use this skill

Trigger this skill when the user asks to **apply a refactoring plan**, with phrasings like:
- "apply the refactor plan"
- "execute the planned refactoring"
- explicit command `/spec-gen-execute-refactor`

**Prerequisite**: the `spec-gen-plan-refactor` skill must have been run and the plan confirmed.
The file `.spec-gen/refactor-plan.md` must exist.

---

## Step 1 — Read the plan

Read `.spec-gen/refactor-plan.md` from the project directory.

If the file does not exist, stop immediately:
> "No refactor plan found at `.spec-gen/refactor-plan.md`. Please run `/spec-gen-plan-refactor` first."

Extract and display a summary:
- Target function, file, and line range
- Strategy and risk score
- Number of changes planned
- Test command
- Acceptance criteria

**Ask the user to confirm before proceeding.**

> **Execution mode**: once confirmed, execute all changes in the plan **without asking for permission between steps**. The only valid reasons to pause mid-execution are: (a) a test fails, (b) you detect potentially lost code (`git diff` shows far more deletions than additions with no new file), or (c) Step 6 is explicitly requested. Any other pause is non-compliant with this skill.

---

## Step 2 — Establish a green baseline

Confirm the test suite is passing using the test command from the plan.

**If tests are already failing, stop and tell the user. Under no circumstances continue on a red baseline — not even if the failures appear pre-existing.** Pre-existing failures must be fixed or explicitly acknowledged in the plan before any refactoring starts. Do not offer to "proceed at your own risk" on a red baseline.

If a coverage tool is available, run it on the target file and compare against the coverage baseline in the plan.

**Coverage thresholds:**

| Coverage on files to touch | Recommendation |
|---|---|
| ≥ 70% lines | Safe — proceed |
| 40–69% lines | Caution — write characterisation tests first |
| < 40% lines | **Stop.** Strongly recommend writing tests first |
| 0% (no tests) | **Blocked.** Propose a minimal test harness, then restart |

If coverage is below 40%:
> "Coverage on the target file is X%. Refactoring without test coverage risks introducing silent regressions. Would you like me to suggest test cases based on the function signatures, or do you want to proceed at your own risk?"

Only continue past this point with **explicit user confirmation**.

**Large file warning**: if the target function spans more than 300 lines:
> "This function is X lines long. Small models (< 13B parameters) may lose code when editing files of this size in a single pass. Recommended approach: apply Change 1 from the plan (smallest extraction) first to reduce the target below 200 lines."

---

## Step 3 — Set the restore point

Verify the working tree is clean:

```bash
git status            # must show: nothing to commit, working tree clean
git log --oneline -1  # note this commit hash — your restore point
```

If there are uncommitted changes, stop and ask the user to commit or stash them first.

Fill in the `Restore point` section of `.spec-gen/refactor-plan.md` with the current commit hash.

---

## Step 4 — Apply changes (one at a time)

**Before each change**, re-read `.spec-gen/refactor-plan.md` to confirm:
- Which change you are on
- Exactly what to extract, where to put it, and which call sites to update

### Editing tool rule

Always prefer a targeted edit tool (`replace_in_file`, `str_replace_based_edit`, `apply_diff`) over a full-file rewrite (`write_to_file`). Only use `write_to_file` if the file is under 100 lines. If a change seems to require `write_to_file` on a larger file, stop and split it into smaller targeted edits.

**Small model constraint**: if the model is under 13B parameters (Mistral Small, Phi, Gemma…), each edit must touch a contiguous block of at most 50 lines. Split if needed.

### For each change in the plan:

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
                     # intentional — moved, not silently dropped.
                     # If deleted lines >> added lines with no new file
                     # created, code was likely lost — abort immediately.
   ```

4. **Run the test suite** (command from the plan). If any test fails, restore immediately:
   ```bash
   git checkout HEAD -- <file>
   ```
   Do **not** accumulate broken state before restoring.

5. **Mark the change as done** in `.spec-gen/refactor-plan.md` by appending `✅` to the change heading, then proceed to the next one.

Repeat until all changes in the plan are marked ✅.

---

## Step 5 — Verify improvement

```xml
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
```

Check each acceptance criterion from the plan:
- Priority score dropped below the target
- Function is no longer in the top-5 list
- Full test suite passes

If not, investigate and iterate (add a new change to the plan if needed).

Run the full test suite one final time to confirm the refactored state is clean.

---

## Step 6 (optional — requires spec-gen generate to have been run)

> ⚠️ This step proposes irreversible changes (deletions, renames). Do not apply anything without explicit user confirmation at each sub-step.

### 6a — Dead code: orphan functions

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_mapping</tool_name>
  <arguments>{"directory": "$DIRECTORY", "orphansOnly": true}</arguments>
</use_mcp_tool>
```

Present the orphan list (kind `function` or `class` only). For each one, check:
- Is it exported and potentially consumed by external code?
- Is it re-exported from an index file?
- Was it simply missed by the LLM?

**Do not delete anything without the user explicitly approving each function.**

### 6b — Naming alignment: spec vocabulary vs actual names

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_mapping</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>
```

Build a table of mismatches and present it before touching any code:

| Current name | Proposed name | File | Confidence |
|---|---|---|---|

Only renames with `confidence: "llm"` should be proposed automatically. Flag `confidence: "heuristic"` entries for manual verification first.

**Wait for explicit user approval of the full rename table before applying any change. Apply renames one file at a time and run tests after each.**

---

## Absolute constraints

- Always re-read `.spec-gen/refactor-plan.md` before each change
- Never use `write_to_file` on a file > 100 lines
- Never accumulate broken state — restore immediately on any test failure
- Always verify the diff before running tests
- Never proceed to Step 6 without explicit user request
- Always flag potentially lost code (deleted lines >> added lines with no new file created)
- Never ask for confirmation between steps — only pause for failures or lost-code signals
- Never continue on a red baseline, regardless of whether failures appear pre-existing
