# Mistral Vibe assets for openlore

Mistral Vibe implementation of the [openlore agentic workflow pattern](../../docs/agentic-workflows/README.md).

## Contents

| Path | Purpose |
|---|---|
| `skills/openlore-analyze-codebase/` | Full static analysis — architecture, call graph, refactor issues, duplicates |
| `skills/openlore-generate/` | Generate OpenSpec specs from analysis results |
| `skills/openlore-brainstorm/` | Design a feature: greenfield (Domain Sketch) or brownfield (Constrained Option Tree) → annotated story |
| `skills/openlore-plan-refactor/` | Identify highest-priority refactor target and write a plan |
| `skills/openlore-execute-refactor/` | Apply a refactor plan produced by openlore-plan-refactor |
| `skills/openlore-implement-story/` | Implement a story with structural pre-flight check, test gate, and drift verification |
| `skills/openlore-debug/` | Debug a bug: hypothesis-first, RED/GREEN test verification, spec invariant feedback loop |
| `antipatterns-template.md` | Starter template for `.claude/antipatterns.md` — copy to your project root |

## Workflow

```mermaid
flowchart TD
    subgraph ANALYSIS ["📊 Analysis (one-time)"]
        A["/openlore-analyze-codebase"] --> B["/openlore-generate"]
    end

    subgraph REFACTOR ["🔧 Refactor cycle (optional)"]
        C["/openlore-plan-refactor\n→ .openlore/refactor-plan.md"] --> D["/openlore-execute-refactor\nchange by change, test gate"]
    end

    subgraph DESIGN ["💡 Design"]
        K["/openlore-brainstorm\ngreenfield or brownfield"] --> L["Won't Do + testable ACs\nadversarial challenge"]
        L --> M["annotate_story\n→ story.md with risk_context"]
    end

    subgraph FEATURE ["⚙️ Feature / Story"]
        E["/openlore-implement-story"] --> F["orient + analyze_impact\nrisk gate ≥ 70 → blocks"]
        F --> F2["adversarial self-check\n+ antipatterns"]
        F2 --> G["search_specs\nread requirements"]
        G --> H["implement"]
        H --> I["tests green ✅"]
        I --> J["check_spec_drift"]
    end

    subgraph DEBUG ["🐛 Debug"]
        N["/openlore-debug\nhypothesis-first"] --> O["RED/GREEN\ntest verification"]
        O --> P["spec invariant\nfeedback loop"]
    end

    B --> C
    B --> K
    M --> E
    D --> E

    style F fill:#fff3cd,stroke:#ffc107
    style I fill:#d4edda,stroke:#28a745
```

## Usage

Copy the skills into your Mistral Vibe project skills directory and invoke them with their slash commands:

```
/openlore-analyze-codebase
/openlore-generate
/openlore-brainstorm
/openlore-plan-refactor
/openlore-execute-refactor
/openlore-implement-story
/openlore-debug
```

Each skill follows the generic pre-flight pattern:
- `orient` + `analyze_impact` before any code change
- adversarial self-check + antipatterns read before first edit
- test gate before `check_spec_drift`
- `check_spec_drift` after tests are green

## Antipatterns

Copy `antipatterns-template.md` to `.claude/antipatterns.md` in your project:

```bash
cp examples/mistral-vibe/antipatterns-template.md .claude/antipatterns.md
```

The antipatterns list is read by `openlore-brainstorm` (Step 1) and `openlore-implement-story` (Step 4b),
and written by `openlore-debug` (Step 9d) when a bug reveals a cross-cutting failure pattern.

## OpenSpec spec baseline

`search_specs` and `check_spec_drift` require specs to exist. Run `/openlore-generate`
once before using `/openlore-implement-story` for the first time — this creates the
baseline that makes spec alignment meaningful.

| State | What to do |
|---|---|
| No specs yet | `/openlore-analyze-codebase` then `/openlore-generate` |
| Specs exist | All skills work as expected |
| Post-sprint spec refresh | `/openlore-generate` again to update specs after new code |

`/openlore-implement-story` detects missing specs automatically and tells you what to do.
