---
name: gsd:openlore-drift
description: Post-phase spec drift check via openlore MCP — verify implementation matches OpenSpec specifications. Run after verify-work and green tests.
argument-hint: "[phase number]"
allowed-tools:
  - mcp__openlore__check_spec_drift
  - mcp__openlore__get_spec
  - Read
  - Write
---

<objective>
Verify that the completed phase implementation is consistent with existing OpenSpec specifications.
Report gaps, stale references, and uncovered files.

Run this after `/gsd:verify-work` confirms the phase is working, not before.
</objective>

<when_to_use>
Run this command:
- After `/gsd:verify-work` passes (or gaps are resolved)
- Before `/gsd:complete-milestone` as a final quality check
- Any time you want to confirm implementation stays aligned with specs

Skip this command:
- Before verify-work passes (drift check on broken code is not useful)

**If no specs exist yet**: do not skip — use this command to trigger `openlore generate`
and create the baseline. See Step 1.
</when_to_use>

<prerequisites>
1. openlore MCP server configured in Claude Code settings
2. Tests passing — confirm with user before proceeding
3. `openlore analyze` cache exists
</prerequisites>

<process>

<step name="check_spec_baseline">
Check whether OpenSpec specs exist:

```bash
ls $PROJECT_ROOT/openspec/specs/ 2>/dev/null | wc -l
```

**If 0 specs found:**
> "No OpenSpec specs exist yet. Running drift check now will flag all files as uncovered,
> which is not actionable.
>
> Run `openlore generate $PROJECT_ROOT` to create a baseline from the current codebase.
> This takes a few minutes and only needs to be done once."

Ask: "Run `openlore generate` now? (yes/no)"
- Yes → run `openlore generate $PROJECT_ROOT`, then proceed
- No → stop, remind user to run before next drift check

**If specs exist**: proceed.
</step>

<step name="confirm_tests">
Ask the user: "Are tests passing for this phase?"

If no: "Fix test failures first. Drift check on a red test suite is not actionable."
Stop here.
</step>

<step name="run_drift">
```
openlore check_spec_drift
  directory: $PROJECT_ROOT
```
</step>

<step name="interpret">
Classify each finding:

| Type | Meaning | Recommended action |
|---|---|---|
| `uncovered` on new files | New code not yet in any spec | Batch for post-milestone spec update |
| `gap` on existing domain | Spec missing new behaviour | Run `openlore generate --domains $DOMAIN` now or post-milestone |
| `stale` | Spec references deleted/renamed function | Fix reference in spec file |
| No drift | ✅ Clean | Done |
</step>

<step name="output">
If drift found:

> Spec drift detected in {N} domain(s). These do not block shipping but should be addressed.
>
> **Now (blocking):** Fix any `stale` references — they indicate broken spec links.
> **Post-milestone (recommended):** Run `openlore generate` to refresh specs for domains with gaps or uncovered files.

Append a `## Spec Drift` section to `.planning/codebase/RISK-CONTEXT.md` (or create it if absent):

```markdown
## Spec Drift — Phase {N}

> Checked on {date} after verify-work passed.

| Domain | Type | Action |
|--------|------|--------|
{rows}
```

If no drift:

> ✅ No spec drift. Phase implementation is consistent with existing OpenSpec specifications.
</step>

</process>
