## Output

openlore writes to the OpenSpec directory structure:

```
openspec/
  config.yaml                # Project metadata
  specs/
    overview/spec.md         # System overview
    architecture/spec.md     # Architecture
    auth/spec.md             # Domain: Authentication
    user/spec.md             # Domain: User management
    api/spec.md              # API specification
  decisions/                 # With --adr flag
    index.md                 # ADR index
    adr-0001-*.md            # Individual decisions
```

Each spec uses RFC 2119 keywords (SHALL, MUST, SHOULD), Given/When/Then scenarios, and technical notes linking to implementation files.

### Analysis Artifacts

Static analysis output is stored in `.openlore/analysis/`:

| File | Description |
|------|-------------|
| `repo-structure.json` | Project structure and metadata |
| `dependency-graph.json` | Import/export relationships, HTTP cross-language edges (JS/TS → Python), and synthesised call edges for Swift/C++ |
| `llm-context.json` | Context prepared for LLM (signatures, call graph) |
| `dependencies.mermaid` | Visual dependency graph |
| `SUMMARY.md` | Human-readable analysis summary |
| `call-graph.json` | Function-level call graph (8 languages: TS/JS, Python, Go, Rust, Ruby, Java, C++, Swift) |
| `refactor-priorities.json` | Refactoring issues by file and function |
| `mapping.json` | Requirement->function mapping (produced by `generate`) |
| `spec-snapshot.json` | Compact coverage summary: git state, per-domain coverage %, uncovered hub functions (auto-updated after `analyze` and `generate`) |
| `audit-report.json` | Latest parity audit report (produced by `openlore audit`) |
| `vector-index/` | LanceDB semantic index (produced by `--embed`) |

`openlore analyze` also writes **`ARCHITECTURE.md`** to your project root -- a Markdown overview of module clusters, entry points, and critical hubs, refreshed on every run.

