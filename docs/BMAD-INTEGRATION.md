# BMAD + spec-gen Integration Guide

This guide explains how to connect [BMAD Method](https://docs.bmad-method.org) with spec-gen
to enable safe, spec-driven development on brownfield codebases.

## Why

BMAD is designed for structured, spec-first development. On brownfield codebases
(existing code without explicit architecture documentation), agents lack the structural
context needed to implement stories safely. spec-gen provides that context via MCP.

## Architecture

```
BMAD Story
    │
    ▼
BMAD Dev Agent
+ dev-brownfield extension   ← loads bmad/agents/dev-brownfield.md
    │
    │  MCP calls
    ▼
spec-gen MCP Server
    │
    ├── orient           → maps story to functions + insertion points
    ├── analyze_impact   → risk score + blast radius per function
    ├── search_specs     → finds relevant OpenSpec requirements
    ├── check_spec_drift → verifies code/spec alignment post-implementation
    └── ...25 other tools
    │
    ▼
Codebase (brownfield)
```

## Setup

### 1. Install spec-gen

```bash
npm install -g spec-gen
# or from this repo:
npm install && npm run build
```

### 2. Connect spec-gen as an MCP server

In your Claude Code / Cline / Cursor MCP configuration:

```json
{
  "mcpServers": {
    "spec-gen": {
      "command": "node",
      "args": ["/path/to/spec-gen/dist/cli/index.js", "mcp", "--watch-auto"]
    }
  }
}
```

### 3. Run the brownfield onboarding task

Before starting any BMAD stories on an existing codebase, run the onboarding task once:

```
/bmad task brownfield-onboarding
```

Or manually: open `bmad/tasks/brownfield-onboarding.md` and follow the steps.

This will:
- Build the call graph and dependency graph
- Generate OpenSpec specifications from the codebase
- Create a risk register of high-complexity functions
- Establish a drift-detection baseline

### 4. Copy BMAD integration files into your project

Copy the `bmad/` directory from this repo into your project:

```bash
cp -r /path/to/spec-gen/bmad/ ./bmad/
```

Or reference them as templates in your BMAD configuration.

### 5. Load the brownfield extension in your dev agent

Add to your BMAD dev agent persona (or include in your project's CLAUDE.md):

```markdown
@bmad/agents/dev-brownfield.md
```

Or prepend the contents of `bmad/agents/dev-brownfield.md` to your BMAD dev agent's system prompt.

---

## File Reference

| File | Purpose |
|---|---|
| `bmad/agents/dev-brownfield.md` | Developer agent extension — adds pre-implementation gate |
| `bmad/tasks/brownfield-onboarding.md` | First-time project setup (run once) |
| `bmad/tasks/implement-story-brownfield.md` | Story implementation on brownfield |
| `bmad/tasks/brownfield-refactor.md` | Safe refactor before touching high-risk functions |

---

## Workflow

### Normal story (low-risk codebase area)

```
Story → orient → analyze_impact (risk < 40) → implement → check_spec_drift → done
```

### Story touching a risky function (risk 40–69)

```
Story → orient → analyze_impact (risk 40–69) → implement with care → check_spec_drift → done
```

### Story blocked by high-risk function (risk ≥ 70)

```
Story → orient → analyze_impact (risk ≥ 70)
                      │
                      ▼
              brownfield-refactor task
                      │
                      ▼
              riskScore < 70?
                      │
                      ▼
              return to story → implement → check_spec_drift → done
```

---

## Integration with OpenSpec

spec-gen generates OpenSpec specifications (`openspec/`) from brownfield code.
Once generated, BMAD's architecture agent and PM agent can read these specs to understand
the existing system before planning new stories.

Key spec files after onboarding:

```
openspec/
├── specs/
│   ├── overview/spec.md         ← system summary for PM / Architect agents
│   ├── architecture/spec.md     ← risk register + structural notes
│   └── {domain}/spec.md         ← per-domain requirements
```

The `search_specs` and `get_spec` MCP tools let dev agents query these specs
during story implementation without leaving their context window.

---

## spec-gen MCP Tools Used by BMAD Tasks

| Tool | Used in | Purpose |
|---|---|---|
| `analyze_codebase` | onboarding | Build/refresh call graph |
| `orient` | implement-story | Map story to functions in one call |
| `analyze_impact` | implement-story, refactor | Risk score + blast radius |
| `get_architecture_overview` | onboarding | Domain clusters + hubs |
| `get_refactor_report` | onboarding, refactor | High-priority refactor candidates |
| `get_duplicate_report` | onboarding, refactor | Clone groups |
| `suggest_insertion_points` | implement-story, refactor | Where to add code |
| `get_subgraph` | implement-story, refactor | Call neighbourhood (Mermaid) |
| `get_function_skeleton` | implement-story | Noise-stripped file view |
| `search_specs` | implement-story | Find relevant requirements |
| `get_spec` | implement-story | Read full domain spec |
| `check_spec_drift` | implement-story | Post-implementation verification |
| `get_low_risk_refactor_candidates` | refactor | Safe extraction targets |
| `get_mapping` | refactor | Dead code / naming alignment |

---

## Troubleshooting

### `orient` returns 0 results

The analysis cache is missing or stale. Run:

```bash
spec-gen analyze
```

Or via MCP:
```xml
<use_mcp_tool>
  <server_name>spec-gen</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT", "force": true}</arguments>
</use_mcp_tool>
```

### `search_specs` returns "index not found"

The semantic index is missing. Run:

```bash
spec-gen analyze --embed
```

### `check_spec_drift` shows many `uncovered` files

OpenSpec has not been generated yet. Run:

```bash
spec-gen generate
```

### Risk scores are unexpectedly high everywhere

This is a brownfield signal — the codebase has accumulated complexity. Start with the
`brownfield-onboarding` task to build a risk register and identify which areas are safe
to work in without first refactoring.
