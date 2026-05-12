# openlore: Check Spec Drift

Detect code changes that are not reflected in the project's OpenSpec specifications.
Runs in static mode — no LLM required, no quota consumed.

**Prerequisites**: `openlore init` and `openlore generate` must have been run at least once
in the target project.

## Step 1: Get the project directory

Ask the user which project to check, or confirm the current workspace root.

<ask_followup_question>
  <question>Which project directory should I check for spec drift?</question>
  <options>["Current workspace root", "Enter a different path"]</options>
</ask_followup_question>

## Step 2: Run drift detection

<use_mcp_tool>
  <server_name>openlore</server_name>
  <tool_name>check_spec_drift</tool_name>
  <arguments>{"directory": "$DIRECTORY"}</arguments>
</use_mcp_tool>

If the result contains `{ "error": "..." }`, stop and tell the user what is missing
(not a git repo / no config / no specs) with the exact remediation command to run.

## Step 3: Present the results

### No drift

If `hasDrift` is false and `issues` is empty:

> ✅ **No spec drift detected.** All changed files are covered by up-to-date specs.

Show `baseRef` and `totalChangedFiles` for context.

### Drift found

Present a summary line first:

```
Drift detected on $totalChangedFiles changed file(s) vs $baseRef
Gaps: $gaps · Stale: $stale · Uncovered: $uncovered · Orphaned: $orphanedSpecs
```

Then a table of issues, sorted by severity (error first):

| Severity | Kind | File | Domain | Spec | Lines changed |
|---|---|---|---|---|---|
| ⛔ error | gap | src/auth/login.ts | auth | specs/auth/spec.md | +45/-12 |
| ⚠️ warning | uncovered | src/billing/invoice.ts | — | — | +120/-0 |

For each issue, show the `suggestion` field on the next line in italic.

## Step 4: Recommend actions

Based on the issue kinds found, guide the user:

### gap (spec exists but is outdated)
> The spec for **$domain** covers `$filePath` but wasn't updated when the code changed.
> Run `openlore generate --domains $domain` to regenerate it, or edit the spec manually
> if the change is minor.

### stale (spec references deleted/moved code)
> The **$domain** spec references code that no longer exists. Either the file was deleted
> or its structure changed significantly. Run `openlore generate --domains $domain` to
> rebuild the spec from the current state of the code.

### uncovered (new file with no spec)
> `$filePath` has no matching spec. If this file introduces new domain logic, run
> `openlore generate` so that openlore can infer a spec from it. If it is a utility
> or test helper, it may not need a spec.

### orphaned-spec (spec references non-existent files)
> A spec references files that no longer exist. The spec may need to be deleted or its
> `source-files` header updated. Review the spec at `$specPath` manually.

## Step 5: Offer to drill down

If there are `gap` or `stale` issues, offer to show the signatures of the affected files
so the user can see exactly what changed in the public API:

<use_mcp_tool>
  <server_name>openlore</server_name>
  <tool_name>get_signatures</tool_name>
  <arguments>{"directory": "$DIRECTORY", "filePattern": "$AFFECTED_FILE"}</arguments>
</use_mcp_tool>

## Step 6: Suggest next steps

Present the following options and let the user choose:

1. **Regenerate specs for affected domains** — run `openlore generate --domains <list>`
   (fastest fix for `gap` and `stale` issues)
2. **Review and edit specs manually** — appropriate for minor changes where the
   existing spec is mostly correct
3. **Install the pre-commit hook** — run `openlore drift --install-hook` so drift is
   caught automatically before every commit
4. **Run `/openlore-plan-refactor` then `/openlore-execute-refactor`** — if the drift
   reveals structural issues in the changed files
