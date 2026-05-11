# spec-gen

**Persistent architectural memory and structural cognition for AI coding agents.**

spec-gen turns any evolving codebase into a navigable knowledge graph backed by [OpenSpec](https://github.com/Fission-AI/OpenSpec) living specifications. It maintains persistent architectural context across agent sessions: graph structure, specs, decisions, drift state, and semantic retrieval — so agents start each task already oriented instead of re-discovering the system from file reads.

---

## Why It Exists

AI agents are powerful but amnesiac. On every new task:

- They re-read the same source files to understand structure
- They forget architectural decisions made two sessions ago
- They have no link between specs and code — drift is invisible
- File-by-file navigation often burns **15,000–50,000 tokens** per orientation pass, before a single line of useful code is written

spec-gen closes this loop. Run a full analysis once, then keep the graph incrementally updated as the codebase evolves. Even greenfield projects become cognitively "brownfield" after only a few agent sessions — architectural context fragments, decisions disappear, and agents repeatedly reconstruct the same understanding from scratch.

spec-gen persists that context continuously: structure, specs, decisions, drift state, and graph relationships remain queryable across sessions.

---

## How It Works

Three layers, each usable independently:

| Layer | What it does | API key? |
|-------|-------------|----------|
| **1. Static Analysis** | Call graph, clusters, McCabe CC, external deps → `CODEBASE.md` digest | No |
| **2. Spec Layer** | LLM-generated living specs, ADRs, drift detection, decision gates | For generation |
| **3. Agent Runtime** | 45 MCP tools — `orient()`, semantic search, graph expansion | No |

You can use layer 1 alone to give agents structural context. Add layer 2 for semantic intent and architectural governance through OpenSpec-compatible living specifications. Layer 3 keeps that context continuously accessible through graph-native MCP tools once `spec-gen mcp` is running.

---

## spec-gen vs. Alternatives

| | Cursor / Claude Code | Sourcegraph | spec-gen |
|---|---|---|---|
| Graph-aware MCP context | ❌ file-based reads | Partial | ✓ call graph + clusters |
| Spec drift detection | ❌ | ❌ | ✓ milliseconds, no API |
| Architectural decision gates | ❌ | ❌ | ✓ pre-commit hook |
| Offline structural analysis | ❌ | ❌ | ✓ |
| Token-efficient orient() | ❌ | ❌ | ✓ ~1–3k vs 15–50k tokens |
| Living spec generation | ❌ | ❌ | ✓ |
| Persistent cross-session architectural memory | ❌ | Partial | ✓ |

Traditional coding agents reconstruct architecture from repeated file reads every session. spec-gen persists it as a queryable graph.

---

## 5-Minute Quickstart

> **Minimum to see value — no API key needed:**

```bash
npm install -g spec-gen-cli
cd /path/to/your-project

spec-gen analyze          # build call graph, clusters, CODEBASE.md
spec-gen mcp              # start MCP server
```

Then ask your agent: **`orient("add a new payment method")`**

That single call returns the relevant functions, their call neighbours, matching spec sections, and insertion-point candidates — preserving architectural continuity across sessions instead of forcing the agent to repeatedly reconstruct context from raw file reads. In practice, this often reduces orientation cost from ~30,000 exploratory tokens to ~1,000 targeted tokens.

**Full pipeline** (specs + decisions — optional and additive):

```bash
spec-gen generate         # generate living specs (requires API key)
spec-gen drift            # detect spec/code drift
spec-gen decisions        # manage architectural decisions
```

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/clay-good/spec-gen
cd spec-gen
npm install && npm run build && npm link
```

</details>

<details>
<summary>Nix / NixOS</summary>

```bash
nix run github:clay-good/spec-gen -- analyze
nix shell github:clay-good/spec-gen
```

System flake:
```nix
environment.systemPackages = [ spec-gen.packages.x86_64-linux.default ];
```

</details>

---

## See It In Action

<details>
<summary>Example: orient("add a payment method")</summary>

```json
{
  "functions": [
    {
      "name": "processPayment",
      "file": "src/payments/processor.ts",
      "risk": "medium",
      "fanIn": 4,
      "callers": ["handleCheckout", "retryFailedCharge"],
      "callType": "direct"
    },
    {
      "name": "validateCard",
      "file": "src/payments/validator.ts",
      "risk": "low",
      "fanIn": 1,
      "testedBy": [{ "name": "validateCard.test.ts", "confidence": "called" }]
    }
  ],
  "specDomains": ["payments — §CardValidation, §PaymentFlow"],
  "insertionPoints": [
    "src/payments/processor.ts:87 — after existing charge logic"
  ],
  "callPath": "POST /charge → handleCheckout → processPayment → validateCard → stripeClient.charge"
}
```

One graph query replaces most exploratory file reads. The agent knows exactly where to look and what risks to consider.

</details>

---

## Core Features

**Analyze** (no API key)

Continuously maintains a structural representation of your codebase using pure static analysis. Builds a full call graph persisted to SQLite, runs label-propagation community detection to cluster tightly coupled functions, computes McCabe cyclomatic complexity for every function, and extracts DB schemas, HTTP routes, UI components, middleware chains, and environment variables. Outputs `.spec-gen/analysis/CODEBASE.md` — a ~600-token structural digest that compresses the equivalent of tens of thousands of exploratory tokens into a small, queryable summary.

With `--watch-auto`, the call graph updates incrementally on every file save: changed file and its direct callers are re-parsed and the graph is atomically swapped. Orient and BFS queries remain live between full analyze runs.

**Generate** (API key required)

Sends the analysis to an LLM in 6 structured stages: project survey → entity extraction → service analysis → API extraction → architecture synthesis → ADR enrichment. Produces `openspec/specs/` living specifications in RFC 2119 format with Given/When/Then scenarios.

**Drift** (no API key)

Compares git changes against spec mappings in milliseconds. Detects: Gap (code changed, spec not updated), Uncovered (new file, no spec), Stale (spec references deleted files), ADR gap (code changed in an ADR-referenced domain). Installs as a pre-commit hook.

**MCP** (no API key)

45 graph-native tools exposed over stdio. Together they act as a persistent architectural runtime for coding agents: orientation, graph traversal, semantic retrieval, drift awareness, decision context, and structural risk analysis.
`orient()` is the main entry point — one call replaces 10+ file reads. `detect_changes` risk-scores changed functions using call graph centrality × change type multiplier. See [docs/mcp-tools.md](docs/mcp-tools.md).

`orient()` runs in **~430µs p50** against a 15k-node codebase (TypeScript compiler, ~79k edges). Full benchmark results: [scripts/BENCHMARKS.md](scripts/BENCHMARKS.md).

**Decisions** (API key for consolidation)

Agents call `record_decision` before writing code. Consolidation runs immediately in the background. At commit time, a pre-commit hook gates the commit until all verified decisions are reviewed and written back as requirements in `spec.md` files. Decisions are classified by scope (`local / component / cross-domain / system`); only `cross-domain` and `system` decisions produce ADR files, keeping the decision log signal-dense.

---

## Architecture

OpenSpec provides semantic intent and workflow structure. spec-gen maintains the evolving implementation as a continuously queryable architectural graph for agents.

```
Codebase
   │
   ▼
spec-gen analyze ──► SQLite graph store (.spec-gen/analysis/call-graph.db)
                          │                      │
                          │              MCP tools (orient, BFS, search…)
                          │                      │
                     Artifact Generator        Agent
                          │
                    ┌─────┴──────┐
                    ▼            ▼
              CODEBASE.md   (optional)
                         spec-gen generate ──► openspec/specs/*.md
                         spec-gen drift   ──► drift report
                         spec-gen decisions ► ADR gates
```

The graph and the OpenSpec spec layer are co-equal: the graph makes orientation fast, the specs make it semantically grounded. Drift detection and decision gates connect both. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full pipeline diagram.

---

## Documentation

| Topic | Doc |
|-------|-----|
| MCP tools reference (45 tools + parameters) | [docs/mcp-tools.md](docs/mcp-tools.md) |
| Agent setup (Claude Code, Cline, OpenCode, Vibe…) | [docs/agent-setup.md](docs/agent-setup.md) |
| LLM providers + embedding config | [docs/providers.md](docs/providers.md) |
| Drift detection in depth | [docs/drift-detection.md](docs/drift-detection.md) |
| Spec-driven tests + spec digest | [docs/spec-tests.md](docs/spec-tests.md) |
| CI/CD integration | [docs/ci-cd.md](docs/ci-cd.md) |
| CLI command reference | [docs/cli-reference.md](docs/cli-reference.md) |
| Interactive graph viewer | [docs/viewer.md](docs/viewer.md) |
| Analysis output files | [docs/output.md](docs/output.md) |
| Configuration reference | [docs/configuration.md](docs/configuration.md) |
| Programmatic API | [docs/api.md](docs/api.md) |
| Pipeline architecture | [docs/pipeline.md](docs/pipeline.md) |
| Internal design | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Algorithms | [docs/ALGORITHMS.md](docs/ALGORITHMS.md) |
| Agentic workflows (BMAD, Vibe, GSD, spec-kit) | [docs/agentic-workflows.md](docs/agentic-workflows.md) |
| Troubleshooting | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| Philosophy | [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) |

---

## Known Limitations

- **Incremental call graph updates are depth-1 only**: `--watch-auto` re-indexes signatures and edges on save for the changed file and its direct callers. Transitive callers (A→B→C, C changes, A stays stale) are only refreshed by the next `analyze --force`. For hub files with 100+ callerFiles, re-parse may take several seconds.
- **Static analysis only**: dynamic dispatch, runtime metaprogramming, and `eval`-based patterns are not captured in the call graph.
- **LLM spec quality varies**: generated specs reflect the model's understanding. Review sections covering complex business logic before treating them as authoritative.
- **Embedding is optional**: without an embedding endpoint, `orient` and `search_code` fall back to BM25 keyword search (still useful, less accurate for semantic queries).
- **Large monorepos**: `spec-gen analyze` on large codebases may take several minutes. Graph storage itself has no practical limit — the pipeline (AST parsing, symbol extraction) is the bottleneck.
- **`node:sqlite` experimental warning on Node 22**: Node.js 22 prints `ExperimentalWarning: SQLite is an experimental feature` to stderr. The warning is gone on Node 24+. Suppress on Node 22 with `NODE_NO_WARNINGS=1 spec-gen analyze`.

---

## Requirements

- Node.js 22.5+
- API key for `generate`, `verify`, and `drift --use-llm`:
  ```bash
  export ANTHROPIC_API_KEY=sk-ant-...    # default provider
  export OPENAI_API_KEY=sk-...           # OpenAI
  export GEMINI_API_KEY=...              # Google Gemini
  ```
  Or use a CLI-based provider (`claude-code`, `gemini-cli`, `mistral-vibe`, `cursor-agent`) — no API key, just the CLI on your PATH.
- `analyze`, `drift`, `mcp`, and `init` require no API key

**Languages supported**: TypeScript · JavaScript · Python · Go · Rust · Ruby · Java · C++ · Swift

---

## Development

```bash
npm install
npm run build
npm test          # 2660+ unit tests
npm run typecheck
```

---

## Links

- [OpenSpec](https://github.com/Fission-AI/OpenSpec) — spec-driven development framework
- [AGENTS.md](AGENTS.md) — system prompt for direct LLM prompting
- [Examples](examples/) — BMAD, Vibe, GSD, drift-demo, spec-kit integrations
