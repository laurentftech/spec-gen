# Agent: Architect — spec-gen extension

> **This file is a sidecar for the BMAD `architect` agent.**
>
> **Setup (one-time):**
> ```bash
> # 1. Copy this file into your BMAD project
> cp examples/bmad/agents/architect.md _bmad/_memory/architect-sidecar/spec-gen.md
>
> # 2. Install the customization that tells BMAD to load it
> cp examples/bmad/setup/architect.customize.yaml \
>    _bmad/_config/customizations/architect.customize.yaml
>
> # 3. Recompile BMAD agents
> npx bmad-method install
> ```
>
> After that, the Architect agent loads this file automatically at session start.
> No manual step needed in the conversation.
>
> Requires: spec-gen MCP server connected and onboarding completed
> (see `tasks/onboarding.md`).

---

## Core Principle

The architecture document MUST reflect the reality of the code,
not just the desired target state. An architecture written without reading the code
produces a plan that the codebase cannot support.

**Produce two documents:**
1. **Structural Reality** — what the code actually is (spec-gen output)
2. **Target Architecture** — what you want it to become (your design)

The gap between them is the technical debt backlog.

---

## Phase 0 — Structural Reality (run before any design work)

### Step 0.1 — Architecture overview

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_architecture_overview</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

Extract:
- **Domain clusters** → existing logical boundaries
- **Cross-cluster dependencies** → where coupling is highest
- **Critical hubs** → functions that act as bottlenecks
- **Entry points** → where control enters the system

If this returns an error, run `analyze_codebase` first.

### Step 0.2 — Risk landscape

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_refactor_report</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

Classify each high-priority candidate:

| Function | Issues | Priority | Classification |
|---|---|---|---|
| ... | high_fan_out | 85 | 🔴 no-touch zone |
| ... | in_cycle | 62 | 🟠 isolate before touching |
| ... | multi_requirement | 38 | 🟡 document carefully |

**No-touch zones** (priority ≥ 70): any story touching these functions is **blocked**
until a refactor story is completed first.

### Step 0.3 — Structural debt

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_duplicate_report</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

Note clone groups — they amplify the cost of any feature that touches duplicated logic.

### Step 0.4 — Critical hubs

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_critical_hubs</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT", "limit": 10, "minFanIn": 3}</arguments>
</use_mcp_tool>
```

Hubs with high fan-in are the riskiest insertion points. Note their recommended approach
(`extract`, `split`, `facade`, `delegate`).

---

## Phase 1 — Feature / Epic Impact Assessment

For each epic or major feature in scope, generate a change proposal:

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>generate_change_proposal</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "description": "$EPIC_DESCRIPTION",
    "slug": "$EPIC_SLUG"
  }</arguments>
</use_mcp_tool>
```

From each proposal:
- **domainsAffected** → which spec domains this epic touches
- **maxRiskScore** → overall risk level of this epic
- **requirementsTouched** → existing requirements this epic overlaps or extends

Build an epic risk matrix:

| Epic | Domains | Max Risk | Blocking Refactors |
|---|---|---|---|
| Add payment retry | payment, api | 🔴 82 | refactor `processPayment` first |
| User email validation | auth, user | 🟢 18 | none |

---

## Phase 2 — Architecture Document

Write `docs/architecture.md` (or the BMAD equivalent) with two mandatory sections:

### Section: Structural Reality

```markdown
## Structural Reality (as-is)

> Generated from spec-gen analysis on {date}.
> Re-run `spec-gen analyze --force` before each planning cycle.

### Domain Map

{paste architecture overview clusters and dependencies}

### No-Touch Zones

Functions that MUST NOT be modified without a prior refactor story:

| Function | File | Risk | Issues |
|---|---|---|---|

### Known Debt

- N clone groups detected
- N cyclic dependencies

### Critical Hubs

Functions requiring the most careful change management:

| Function | Fan-in | Recommended approach |
|---|---|---|
```

### Section: Target Architecture

Design the future state here — new domains, desired boundaries, patterns to introduce.
**For each structural gap between reality and target, create a technical debt story.**

---

## Phase 3 — Technical Debt Backlog

For every no-touch zone, create a **refactor story** in the BMAD backlog:

Use the template `bmad/templates/story.md` with:
- Story type: `technical-debt`
- Title: `Refactor {function}: {issue}`
- Blocking: list stories that cannot proceed until this is done
- **Won't Do**: at minimum one item — scope the refactor tightly (e.g. "Won't change the public API", "Won't refactor callers")
- **Acceptance Criteria**: must be testable — state observable outcomes (e.g. "riskScore drops below 70", "no caller changes required")

These stories MUST be sprint-scheduled before any story that depends on the refactored function.

---

## Phase 4 — Annotate Stories with Risk Context

For each story in the backlog, run `annotate_story` — do not fill `risk_context` manually.

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

The tool reads the story file, runs `orient` + `analyze_impact`, and writes the
`risk_context` section directly. Existing sections are replaced, not appended.

Re-run after any completed refactor story — risk scores change as the code evolves.

The Dev Agent reads this context at sprint time — it does **not** discover it.

---

## Absolute Constraints

- Never write a target architecture without first completing Phase 0
- Never assign a story touching a no-touch zone without a blocking refactor story in the backlog
- Always run `annotate_story` on stories before they enter a sprint — never fill risk_context manually
- Re-run Phase 0 at the start of each planning cycle — the structural reality changes
