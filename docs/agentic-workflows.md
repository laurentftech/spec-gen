## Agentic Workflows

openlore integrates with structured agentic workflows so AI agents follow a consistent process: orient → risk check → spec check → implement → drift verify.

| Integration | Description | Location |
|-------------|-------------|----------|
| **BMAD** | Brownfield agent workflow with architect + dev agents. Architect annotates stories with risk context at planning time; dev agent uses it to skip orientation on low-risk stories. | `examples/bmad/` |
| **Mistral Vibe** | Skills for Mistral-powered agents (brainstorm, implement story, debug, plan/execute refactor). Includes small-model constraints (≤50-line edits). | `examples/mistral-vibe/` |
| **GSD** | Minimal slash commands for `openlore orient` and `openlore drift` — drop into any agent that supports custom commands. | `examples/gsd/` |
| **spec-kit** | Extension layer adding structural risk analysis to any existing agent setup. | `examples/spec-kit/` |
| **Cline** | Workflow markdown files for Cline / Roo Code / Kilocode. Copy to `.clinerules/workflows/`. | `examples/cline-workflows/` |

Each integration ships with a README explaining setup and the step-by-step workflow.

