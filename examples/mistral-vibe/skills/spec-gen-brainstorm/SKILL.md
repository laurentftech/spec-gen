---
name: spec-gen-brainstorm
description: Transform a feature idea into an annotated story with risk_context pre-filled, using spec-gen structural context before any design discussion. Ensures architectural reality informs design choices.
license: MIT
compatibility: spec-gen MCP server
user-invocable: true
allowed-tools:
  - ask_followup_question
  - use_mcp_tool
  - read_file
  - write_file
  - str_replace_based_edit
  - run_command
---

# spec-gen: Brainstorm

## When to use this skill

Trigger this skill when the user wants to **explore or design a new feature** before
writing any code, with phrasings like:
- "I want to add feature X"
- "how should I approach this?"
- "let's brainstorm this story"
- explicit command `/spec-gen-brainstorm`

**The rule**: structural context comes before design questions. Do not ask
architecture or design questions before running Steps 2–4.

**Prerequisite**: spec-gen analysis must exist (`spec-gen analyze` has been run).
If `orient` returns `"error": "no cache"` → run `analyze_codebase` first, then retry.

---

## Step 1 — Read the project context

Check whether `openspec/specs/` exists in `$PROJECT_ROOT`.

| Situation | Action |
|---|---|
| `openspec/specs/` exists | Proceed — `search_specs` will be available in Step 4 |
| `openspec/specs/` absent | Warn the user: "No specs found. `search_specs` will be skipped. Run `spec-gen generate` for better results." Proceed without it. |

Capture `$PROJECT_ROOT`, `$FEATURE_DESCRIPTION` (from the user's request),
and `$FEATURE_SLUG` (kebab-case, ≤ 5 words, e.g. `payment-retry-flow`).

---

## Step 2 — Orient

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>orient</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "task": "$FEATURE_DESCRIPTION",
    "limit": 7
  }</arguments>
</use_mcp_tool>
```

Extract:
- **`$TOP_FUNCTIONS`** — top 2–3 functions by relevance score
- **`$DOMAINS_AFFECTED`** — spec domains touched
- **`$INSERTION_POINTS`** — candidate insertion locations

---

## Step 3 — Architecture overview

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_architecture_overview</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

Note:
- **Hub functions** in `$DOMAINS_AFFECTED` — features touching hubs carry inherent risk
- **Cross-domain dependencies** — signals that the feature may ripple beyond its primary domain

---

## Step 4 — Generate change proposal

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>generate_change_proposal</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "description": "$FEATURE_DESCRIPTION",
    "slug": "$FEATURE_SLUG"
  }</arguments>
</use_mcp_tool>
```

This tool chains `orient` + `search_specs` + `analyze_impact` and writes
`openspec/changes/$FEATURE_SLUG/proposal.md`.

Extract from the result:
- **`$MAX_RISK_SCORE`** — overall risk level of the feature
- **`$REQUIREMENTS_TOUCHED`** — existing requirements this feature overlaps
- **`$BLOCKING_REFACTORS`** — functions with risk ≥ 70 that must be refactored first

**Risk gate:**

| Score | Situation | Action |
|---|---|---|
| 🟢 < 40 | Low risk | Proceed to brainstorming |
| 🟡 40–69 | Medium risk | Proceed, flag impacted callers to protect during design |
| 🔴 ≥ 70 | Blocked | Stop — inform the user, propose a blocking refactor story before continuing |

If `$MAX_RISK_SCORE ≥ 70`, output:

> "This feature touches `$BLOCKING_FUNCTION` (risk score: $SCORE).
> A refactor story must be completed before this feature can be implemented safely.
> I can create the refactor story now if you'd like."

Do not continue to Step 5 until the user either accepts the refactor story or
explicitly acknowledges the risk and overrides the gate.

---

## Step 5 — Informed brainstorming

Only now engage in design discussion with the user.

Ask questions that are grounded in the structural context from Steps 2–4:
- "The proposal identified `$FUNCTION` as the main insertion point — does that align with your intent?"
- "This feature touches `$DOMAIN` which has `$N` existing requirements. Should it extend or replace `$REQUIREMENT`?"
- "The architecture shows `$HUB` as a bottleneck in this area — should we route around it or go through it?"

Do not ask generic design questions (e.g. "what should this do?") that ignore
the structural context already gathered.

---

## Step 6 — Write the story

Produce a story file at `$STORIES_DIR/$FEATURE_SLUG.md`.

If a story template exists at `$PROJECT_ROOT/examples/bmad/templates/story.md`
or `$PROJECT_ROOT/_bmad/spec-gen/templates/story.md`, use it. Otherwise use
this structure:

```markdown
# $STORY_TITLE

## Goal

$FEATURE_DESCRIPTION

## Acceptance Criteria

- [ ] $AC_1
- [ ] $AC_2

## Risk Context

<!-- Filled by annotate_story in Step 7 -->

## Technical Constraints

$CONSTRAINTS_FROM_PROPOSAL

## Notes

- Domains affected: $DOMAINS_AFFECTED
- Requirements touched: $REQUIREMENTS_TOUCHED
- Max risk score: $MAX_RISK_SCORE
```

Fill `## Technical Constraints` from `$BLOCKING_REFACTORS` and any caller
protection notes from the proposal.

---

## Step 7 — Annotate the story

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>annotate_story</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "storyFilePath": "$STORY_FILE_PATH",
    "description": "$STORY_TITLE"
  }</arguments>
</use_mcp_tool>
```

This patches `## Risk Context` in the story file directly. The story is now
ready to be passed to `spec-gen-implement-story`.

Confirm to the user:
> "Story written to `$STORY_FILE_PATH` with risk context pre-filled.
> Pass it to `/spec-gen-implement-story` when ready to implement."

---

## Absolute constraints

- Do not ask design questions before Step 4 (`generate_change_proposal`) is complete
- If `$MAX_RISK_SCORE ≥ 70` — do not proceed to brainstorming without acknowledgement
- If `openspec/specs/` is absent — mention the limitation but do not block
- Do not fill `## Risk Context` manually — always use `annotate_story`
- Do not propose implementation steps — this skill ends at story creation
