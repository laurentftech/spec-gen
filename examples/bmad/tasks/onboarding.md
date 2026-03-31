# Task: Brownfield Onboarding

**Purpose**: Establish a structural baseline on an existing codebase.
**Phase**: Architecture — run this BEFORE writing architecture documents, planning epics, or creating stories.
Run once per project, then re-run at the start of each planning cycle (quarterly or after major refactors).

**Who runs this**: Architect Agent (not Dev Agent).

**Output**: populated `openspec/` + `.spec-gen/` + risk register embedded in architecture doc.

**Estimated time**: 5–15 minutes depending on codebase size.

---

## Prerequisites

- spec-gen MCP server connected
- `spec-gen` CLI available (`npx spec-gen` or local install)
- Read access to the project directory

---

## Step 1 — Run static analysis

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "force": false
  }</arguments>
</use_mcp_tool>
```

Expected output: summary with module count, function count, cycle count.
If `cycles_detected > 0`, note it — this is a brownfield risk signal.

---

## Step 2 — Understand the architecture

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_architecture_overview</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

From the result, record:
- **Domain clusters** (the logical groupings spec-gen detected)
- **Cross-cluster dependencies** (coupling risks)
- **Entry points** (where requests enter the system)
- **Critical hubs** (high fan-in functions — touch with care)

---

## Step 3 — Identify hotspots

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_refactor_report</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

Create a brownfield risk register — a simple table:

| Function | File | Issues | Priority | Action |
|---|---|---|---|---|
| ... | ... | high_fan_out | 85 | Refactor before touching |
| ... | ... | in_cycle | 60 | Isolate cycle first |
| ... | ... | multi_requirement | 40 | Document carefully |

Functions with priority > 70 are **no-touch zones** until refactored.

---

## Step 4 — Check for duplicate code

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>get_duplicate_report</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>
```

Note any clone groups — they indicate debt that will multiply if features are added naively.

---

## Step 5 — Generate OpenSpec (if no specs exist)

If `openspec/` does not exist or has no specs, generate them:

```bash
spec-gen analyze --embed
spec-gen generate
```

Or trigger the spec-gen skill in your AI agent:

> "Run spec-gen on this codebase and generate OpenSpec specifications."

This creates `openspec/specs/{domain}/spec.md` for each detected domain.
Commit the result — these become the baseline for drift detection.

---

## Step 6 — Verify spec coverage

```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>check_spec_drift</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "base": "HEAD"
  }</arguments>
</use_mcp_tool>
```

At this point drift should be zero (we just generated specs from HEAD).
If `uncovered` files appear, add them to the backlog as "spec missing" items.

---

## Step 7 — Record the baseline

Create or update `openspec/specs/architecture/spec.md` with a **brownfield baseline** section:

```markdown
## Brownfield Baseline

> Established: {date}

### Risk Register

| Function | Issues | Priority |
|---|---|---|
| ... | ... | ... |

### No-touch zones (priority > 70)

- `functionName` in `path/to/file.ts` — reason

### Known duplicate groups

- N clone groups detected (see `.spec-gen/analysis/`)

### Onboarding notes

- ...
```

---

## Completion Criteria

- [ ] `spec-gen analyze` completed without error
- [ ] Architecture overview reviewed and understood
- [ ] Risk register created with functions priority > 70 flagged
- [ ] `openspec/` populated (generated or pre-existing)
- [ ] `check_spec_drift` shows zero drift on HEAD
- [ ] Baseline documented in `openspec/specs/architecture/spec.md`
- [ ] BMAD project backlog updated with any "spec missing" items
