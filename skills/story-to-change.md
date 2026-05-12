# SKILL: story-to-change

## When to use this skill

Trigger this skill when:
- A BMAD story is ready for implementation and the project uses OpenSpec
- The user asks to "create a change proposal", "generate a spec delta", or "translate this story to OpenSpec"
- A brownfield project needs to bridge BMAD intent with OpenSpec before implementation
- explicit command `/story-to-change`

**This skill writes no code.** It produces `openspec/changes/{slug}/proposal.md` only.
To implement the change, use `openlore-implement-feature` or the BMAD dev agent.

---

## Step 1 — Confirm inputs

Ask the user:
```
Which project directory?
What is the change slug? (e.g. "add-payment-retry", "user-email-validation")
Paste the BMAD story content, or describe the intent in 1–3 sentences.
```

Store as `$DIRECTORY`, `$SLUG`, `$STORY_CONTENT`.

If the user provides a BMAD story file path, read it first.

---

## Step 2 — Generate the change proposal

```xml
<use_mcp_tool>
  <server_name>openlore</server_name>
  <tool_name>generate_change_proposal</tool_name>
  <arguments>{
    "directory": "$DIRECTORY",
    "description": "$STORY_TITLE — $PRIMARY_AC",
    "slug": "$SLUG",
    "storyContent": "$STORY_CONTENT"
  }</arguments>
</use_mcp_tool>
```

If the result contains `"error": "No analysis found"`, run `analyze_codebase` first, then retry.

---

## Step 3 — Summarise to the user

Present:
- **Proposal written at**: `openspec/changes/{slug}/proposal.md`
- **Domains affected**: list
- **Requirements touched**: N existing requirements found
- **Max risk score**: N (`low` / `medium` / `high` / `critical`)

If risk is `high` or `critical`:
> "⚠️ One or more functions in scope have high risk scores. Consider running `/openlore-plan-refactor`
> before implementing this change."

---

## Step 4 — Review gate

Ask the user to open `openspec/changes/{slug}/proposal.md` and:
1. Review the "Proposed Spec Changes" section — fill in the actual requirement deltas
2. Confirm the affected domains and touched requirements are correct
3. Adjust the insertion points if needed

**Do not proceed to implementation until the user confirms the proposal is complete.**

---

## Step 5 — Suggest next steps

Once the user confirms the proposal:

```
openspec specs {slug}    → formalise the spec delta as proper OpenSpec requirements
openspec design {slug}   → generate a technical design artifact
openspec tasks {slug}    → generate implementation tasks (maps to BMAD story tasks)
```

Or use the BMAD dev brownfield workflow:
> "Load `bmad/tasks/implement-story-brownfield.md` and use the proposal as your context."

---

## Absolute constraints

- Always read the story file before calling the tool if a path is provided
- Never skip the review gate in Step 4
- Never call this tool more than once for the same slug without user confirmation
  (it will overwrite an existing proposal)
