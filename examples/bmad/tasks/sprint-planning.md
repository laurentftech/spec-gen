# Task: Sprint Planning

**Purpose**: Validate a sprint candidate before committing to it.
Detects conflicts, blocked stories, and ordering constraints using structural analysis.

**Who runs this**: Scrum Master Agent or Architect Agent, during sprint planning.
**When**: Before the sprint is locked — after stories are written, before they're assigned.

**Output**: sprint risk report + recommended story order + blocking issues list.

---

## Prerequisites

- Onboarding completed (`bmad/tasks/onboarding.md`)
- All sprint candidate stories have a `risk_context` section
- If `risk_context` is missing on any story, run `annotate_story` on it first (not manually)

---

## Step 1 — Refresh the structural analysis

If the last `analyze_codebase` run was more than 24 hours ago, or if code changed since then:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT", "force": false}</arguments>
</use_mcp_tool>
```

---

## Step 2 — Collect risk data per story

For each story in the sprint candidate list:

**If `risk_context` is already populated** (normal case — architect did their job):
Read it directly from the story file. No MCP call needed.

**If `risk_context` is absent**, run `annotate_story` now:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>annotate_story</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "storyFilePath": "$STORY_FILE_PATH",
    "description": "$STORY_TITLE — $PRIMARY_AC"
  }</arguments>
</use_mcp_tool>
```

Collect from each story's `risk_context`:
- `Domains` → which spec domains are touched
- `Max risk score` + level
- `Blocking refactors` → any listed
- `Functions in scope` → for conflict detection

**Also verify story quality:**
- `## Won't Do` section must be present with at least 1 item
- Every AC must be testable (specific observable outcome, not a vague quality)

Flag non-compliant stories:
> "⚠️ Story S-NN is missing `## Won't Do` / has vague ACs — return to author before sprint lock."

---

## Step 3 — Build the sprint risk matrix

| Story | Domains | Risk | Blocking Refactors | Status |
|---|---|---|---|---|
| S-01 Add retry | payment | 🔴 82 | `processPayment` | ⛔ blocked |
| S-02 Email validation | auth | 🟢 18 | none | ✅ ready |
| S-03 Rate limiting | api | 🟡 45 | none | ⚠️ caution |

**Status rules:**
- ⛔ **blocked**: max risk ≥ 70 and no refactor story scheduled before it
- ⚠️ **caution**: max risk 40–69, or story touches a critical hub
- ✅ **ready**: max risk < 40 and no hub involvement

---

## Step 4 — Detect function conflicts

Find stories whose `functions in scope` overlap.

Get the full hub list to cross-reference:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_critical_hubs</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT", "limit": 15}</arguments>
</use_mcp_tool>
```

For each hub that appears in two or more stories' function scope:

> "⚠️ Stories S-01 and S-04 both touch `processPayment` (fan-in: 12).
> Parallel risk: merge conflicts and silent regressions.
> Recommend: sequence them, or assign to the same developer."

---

## Step 5 — Check spec coverage gaps

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>check_spec_drift</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

For any `uncovered` files already present:
> "Stories touching these files cannot use `check_spec_drift` as a completion gate.
> Add a `spec-gen generate` task to the sprint."

---

## Step 6 — Determine story ordering

**Rules:**
1. Refactor stories before the stories they unblock
2. Stories touching the same hub: sequence, do not parallelise
3. Low-risk stories can be parallelised freely
4. `spec-gen generate` after any story that adds new source files

---

## Step 7 — Sprint readiness verdict

| Criterion | Status |
|---|---|
| No ⛔ stories without prior refactor scheduled | ✅ / ⛔ |
| No parallel stories on the same hub | ✅ / ⚠️ |
| All stories have `risk_context` | ✅ / ⛔ |
| All stories have `## Won't Do` and testable ACs | ✅ / ⚠️ |
| Spec coverage adequate for drift detection | ✅ / ⚠️ |

**If any ⛔ remain: do not lock the sprint.** Resolve blockers first.

---

## Output

Write the sprint plan to `.spec-gen/sprints/sprint-{N}.md`:

```markdown
# Sprint {N} — Risk Report

Generated: {date}

## Risk Matrix
{table from Step 3}

## Conflicts
{list from Step 4}

## Recommended Order
{from Step 6}

## Readiness
{verdict from Step 7}
```
