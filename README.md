# spec-gen

Reverse-engineer [OpenSpec](https://github.com/Fission-AI/OpenSpec) specifications from existing codebases, then keep them in sync as code evolves.

## The Problem

Most software has no specification. The code is the spec, scattered across thousands of files, tribal knowledge, and stale documentation. Tools like `openspec init` create empty scaffolding, but someone still has to write everything. By the time specs are written manually, the code has already changed.

spec-gen automates this. It analyzes your codebase through static analysis, generates structured specifications using an LLM, and continuously detects when code and specs fall out of sync.

## Quick Start

```bash
# Install from npm
npm install -g spec-gen-cli

# Navigate to your project
cd /path/to/your-project

# Run the pipeline
spec-gen init       # Detect project type, create config
spec-gen analyze    # Static analysis (no API key needed)
spec-gen generate   # Generate specs (requires API key)
spec-gen drift      # Check for spec drift
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
<summary>Nix/NixOS</summary>

**Run directly:**

```bash
nix run github:clay-good/spec-gen -- init
nix run github:clay-good/spec-gen -- analyze
nix run github:clay-good/spec-gen -- generate
```

**Temporary shell:**

```bash
nix shell github:clay-good/spec-gen
spec-gen --version
```

**System flake integration:**

```nix
{
  inputs.spec-gen.url = "github:clay-good/spec-gen";

  outputs = { self, nixpkgs, spec-gen }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [{
        environment.systemPackages = [ spec-gen.packages.x86_64-linux.default ];
      }];
    };
  };
}
```

**Development:**

```bash
git clone https://github.com/clay-good/spec-gen
cd spec-gen
nix develop
npm run dev
```

</details>

## What It Does

**1. Analyze** (no API key needed)

Scans your codebase using pure static analysis:
- Walks the directory tree, respects .gitignore, scores files by significance
- Parses imports and exports to build a dependency graph
- Clusters related files into business domains automatically
- Produces structured context that makes LLM generation more accurate

**2. Generate** (API key required)

Sends the analysis context to an LLM to produce specifications:
- Stage 1: Project survey and categorization
- Stage 2: Entity extraction (core data models)
- Stage 3: Service analysis (business logic)
- Stage 4: API extraction (HTTP endpoints)
- Stage 5: Architecture synthesis (overall structure)
- Stage 6: ADR enrichment (Architecture Decision Records, with `--adr`)

**3. Verify** (API key required)

Tests generated specs by predicting file contents from specs alone, then comparing predictions to actual code. Reports an accuracy score and identifies gaps.

**4. Drift Detection** (no API key needed)

Compares git changes against spec file mappings to find divergence:
- **Gap**: Code changed but its spec was not updated
- **Stale**: Spec references deleted or renamed files
- **Uncovered**: New files with no matching spec domain
- **Orphaned**: Spec declares files that no longer exist
- **ADR gap**: Code changed in a domain referenced by an ADR
- **ADR orphaned**: ADR references domains that no longer exist in specs

## Architecture

```mermaid
graph TD
    subgraph CLI["CLI Layer"]
        CMD[spec-gen commands]
    end

    subgraph API["Programmatic API"]
        API_INIT[specGenInit]
        API_ANALYZE[specGenAnalyze]
        API_GENERATE[specGenGenerate]
        API_VERIFY[specGenVerify]
        API_DRIFT[specGenDrift]
        API_RUN[specGenRun]
    end

    subgraph Core["Core Layer"]
        direction TB

        subgraph Init["Init"]
            PD[Project Detector]
            CM[Config Manager]
        end

        subgraph Analyze["Analyze -- no API key"]
            FW[File Walker] --> SS[Significance Scorer]
            SS --> IP[Import Parser]
            IP --> DG[Dependency Graph]
            DG --> RM[Repository Mapper]
            RM --> AG[Artifact Generator]
        end

        subgraph Generate["Generate -- API key required"]
            SP[Spec Pipeline] --> FF[OpenSpec Formatter]
            FF --> OW[OpenSpec Writer]
            SP --> ADR[ADR Generator]
        end

        subgraph Verify["Verify -- API key required"]
            VE[Verification Engine]
        end

        subgraph Drift["Drift -- no API key"]
            GA[Git Analyzer] --> SM[Spec Mapper]
            SM --> DD[Drift Detector]
            DD -.->|optional| LE[LLM Enhancer]
        end

        LLM[LLM Service -- Anthropic / OpenAI / Compatible]
    end

    CMD --> API_INIT & API_ANALYZE & API_GENERATE & API_VERIFY & API_DRIFT
    API_RUN --> API_INIT & API_ANALYZE & API_GENERATE

    API_INIT --> Init
    API_ANALYZE --> Analyze
    API_GENERATE --> Generate
    API_VERIFY --> Verify
    API_DRIFT --> Drift

    Generate --> LLM
    Verify --> LLM
    LE -.-> LLM

    AG -->|analysis artifacts| SP
    AG -->|analysis artifacts| VE

    subgraph Output["Output"]
        SPECS[openspec/specs/*.md]
        ADRS[openspec/decisions/*.md]
        ANALYSIS[.spec-gen/analysis/]
        REPORT[Drift Report]
    end

    OW --> SPECS
    ADR --> ADRS
    AG --> ANALYSIS
    DD --> REPORT
```

## Drift Detection

Drift detection is the core of ongoing spec maintenance. It runs in milliseconds, needs no API key, and works entirely from git diffs and spec file mappings.

```bash
$ spec-gen drift

  Spec Drift Detection

  Analyzing git changes...
  Base ref: main
  Branch: feature/add-notifications
  Changed files: 12

  Loading spec mappings...
  Spec domains: 6
  Mapped source files: 34

  Detecting drift...

   Issues Found: 3

   [ERROR] gap: src/services/user-service.ts
      Spec: openspec/specs/user/spec.md
      File changed (+45/-12 lines) but spec was not updated

   [WARNING] uncovered: src/services/email-queue.ts
      New file has no matching spec domain

   [INFO] adr-gap: openspec/decisions/adr-0001-jwt-auth.md
      Code changed in domain(s) auth referenced by ADR-001

   Summary:
     Gaps: 2
     Uncovered: 1
     ADR gaps: 1
```

### ADR Drift Detection

When `openspec/decisions/` contains Architecture Decision Records, drift detection automatically checks whether code changes affect domains referenced by ADRs. ADR issues are reported at `info` severity since code changes rarely invalidate architectural decisions. Superseded and deprecated ADRs are excluded.

### LLM-Enhanced Mode

Static drift detection catches structural changes but cannot tell whether a change actually affects spec-documented behavior. A variable rename triggers the same alert as a genuine behavior change.

`--use-llm` post-processes gap issues by sending each file's diff and its matching spec to the LLM. The LLM classifies each gap as relevant (keeps the alert) or not relevant (downgrades to info). This reduces false positives.

```bash
spec-gen drift              # Static mode: fast, deterministic
spec-gen drift --use-llm    # LLM-enhanced: fewer false positives
```

## CI/CD Integration

spec-gen is designed to run in automated pipelines. The deterministic commands (`init`, `analyze`, `drift`) need no API key and produce consistent results.

### Pre-Commit Hook

```bash
spec-gen drift --install-hook     # Install
spec-gen drift --uninstall-hook   # Remove
```

The hook runs in static mode (fast, no API key needed) and blocks commits when drift is detected at warning level or above.

### GitHub Actions / CI Pipelines

```yaml
# .github/workflows/spec-drift.yml
name: Spec Drift Check
on: [pull_request]
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0    # Full history needed for git diff
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install -g spec-gen-cli
      - run: spec-gen drift --fail-on error --json
```

```bash
# Or in any CI script
spec-gen drift --fail-on error --json    # JSON output, fail on errors only
spec-gen drift --fail-on warning         # Fail on warnings too
spec-gen drift --domains auth,user       # Check specific domains
spec-gen drift --no-color                # Plain output for CI logs
```

### Deterministic vs. LLM-Enhanced

| | Deterministic (Default) | LLM-Enhanced |
|---|---|---|
| **API key** | No | Yes |
| **Speed** | Milliseconds | Seconds per LLM call |
| **Commands** | `analyze`, `drift`, `init` | `generate`, `verify`, `drift --use-llm` |
| **Reproducibility** | Identical every run | May vary |
| **Best for** | CI, pre-commit hooks, quick checks | Initial generation, reducing false positives |

## LLM Providers

spec-gen supports four providers. The default is Anthropic Claude.

| Provider | `provider` value | API key env var | Default model |
|----------|-----------------|-----------------|---------------|
| Anthropic Claude | `anthropic` *(default)* | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| OpenAI-compatible *(Mistral, Groq, Ollama...)* | `openai-compat` | `OPENAI_COMPAT_API_KEY` | `mistral-large-latest` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.0-flash` |

### Selecting a provider

Set `provider` (and optionally `model`) in the `generation` block of `.spec-gen/config.json`:

```json
{
  "generation": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "domains": "auto"
  }
}
```

Override the model for a single run:
```bash
spec-gen generate --model claude-opus-4-20250514
```

### OpenAI-compatible servers (Ollama, Mistral, Groq, LM Studio, vLLM...)

Use `provider: "openai-compat"` with a base URL and API key:

**Environment variables:**
```bash
export OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1   # Ollama, LM Studio, local servers
export OPENAI_COMPAT_API_KEY=ollama                       # any non-empty value for local servers
                                                          # use your real API key for cloud providers (Mistral, Groq...)
```

**Config file** (per-project):
```json
{
  "generation": {
    "provider": "openai-compat",
    "model": "llama3.2",
    "openaiCompatBaseUrl": "http://localhost:11434/v1",
    "domains": "auto"
  }
}
```

**Self-signed certificates** (internal servers, VPN endpoints):
```bash
spec-gen generate --insecure
```
Or in `config.json`:
```json
{
  "generation": {
    "provider": "openai-compat",
    "openaiCompatBaseUrl": "https://internal-llm.corp.net/v1",
    "skipSslVerify": true,
    "domains": "auto"
  }
}
```

Works with: Ollama, LM Studio, Mistral AI, Groq, Together AI, LiteLLM, vLLM,
text-generation-inference, LocalAI, Azure OpenAI, and any `/v1/chat/completions` server.

### Custom base URL for Anthropic or OpenAI

To redirect the built-in Anthropic or OpenAI provider to a proxy or self-hosted endpoint:

```bash
# CLI (one-off)
spec-gen generate --api-base https://my-proxy.corp.net/v1

# Environment variable
export ANTHROPIC_API_BASE=https://my-proxy.corp.net/v1
export OPENAI_API_BASE=https://my-proxy.corp.net/v1
```

Or in `config.json` under the `llm` block:
```json
{
  "llm": {
    "apiBase": "https://my-proxy.corp.net/v1",
    "sslVerify": false
  }
}
```

`sslVerify: false` disables TLS certificate validation -- use only for internal servers with self-signed certificates.

Priority: CLI flags > environment variables > config file > provider defaults.

## Commands

| Command | Description | API Key |
|---------|-------------|---------|
| `spec-gen init` | Initialize configuration | No |
| `spec-gen analyze` | Run static analysis | No |
| `spec-gen generate` | Generate specs from analysis | Yes |
| `spec-gen generate --adr` | Also generate Architecture Decision Records | Yes |
| `spec-gen verify` | Verify spec accuracy | Yes |
| `spec-gen drift` | Detect spec drift (static) | No |
| `spec-gen drift --use-llm` | Detect spec drift (LLM-enhanced) | Yes |
| `spec-gen run` | Full pipeline: init, analyze, generate | Yes |
| `spec-gen view` | Launch interactive graph & spec viewer in the browser | No |
| `spec-gen mcp` | Start MCP server (stdio, for Cline / Claude Code) | No |

### Global Options

```bash
--api-base <url>       # Custom LLM API base URL (proxy / self-hosted)
--insecure             # Disable SSL certificate verification
--config <path>        # Config file path (default: .spec-gen/config.json)
-q, --quiet            # Errors only
-v, --verbose          # Debug output
--no-color             # Plain text output (enables timestamps)
```

Generate-specific options:
```bash
--model <name>         # Override LLM model (e.g. gpt-4o-mini, llama3.2)
```

### Drift Options

```bash
spec-gen drift [options]
  --base <ref>           # Git ref to compare against (default: auto-detect)
  --files <paths>        # Specific files to check (comma-separated)
  --domains <list>       # Only check specific domains
  --use-llm              # LLM semantic analysis
  --json                 # JSON output
  --fail-on <severity>   # Exit non-zero threshold: error, warning, info
  --max-files <n>        # Max changed files to analyze (default: 100)
  --install-hook         # Install pre-commit hook
  --uninstall-hook       # Remove pre-commit hook
```

### Generate Options

```bash
spec-gen generate [options]
  --model <name>         # LLM model to use
  --dry-run              # Preview without writing
  --domains <list>       # Only generate specific domains
  --merge                # Merge with existing specs
  --no-overwrite         # Skip existing files
  --adr                  # Also generate ADRs
  --adr-only             # Generate only ADRs
```

### Analyze Options

```bash
spec-gen analyze [options]
  --output <path>        # Output directory (default: .spec-gen/analysis/)
  --max-files <n>        # Max files (default: 500)
  --include <glob>       # Additional include patterns
  --exclude <glob>       # Additional exclude patterns
  --force                # Force re-analysis (bypass 1-hour cache)
  --embed                # Build semantic vector index after analysis (requires embedding config)
```

### Verify Options

```bash
spec-gen verify [options]
  --samples <n>          # Files to verify (default: 5)
  --threshold <0-1>      # Minimum score to pass (default: 0.7)
  --files <paths>        # Specific files to verify
  --domains <list>       # Only verify specific domains
  --json                 # JSON output
```

## MCP Server

`spec-gen mcp` starts spec-gen as a [Model Context Protocol](https://modelcontextprotocol.io/) server over stdio, exposing static analysis as tools that any MCP-compatible AI agent (Cline, Roo Code, Kilocode, Claude Code, Cursor...) can call directly -- no API key required.

### Setup

**Claude Code** -- add a `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "spec-gen": {
      "command": "spec-gen",
      "args": ["mcp"]
    }
  }
}
```

or for local development:

```json
{
  "mcpServers": {
    "spec-gen": {
      "command": "node",
      "args": ["/absolute/path/to/spec-gen/dist/cli/index.js", "mcp"]
    }
  }
}
```

**Cline / Roo Code / Kilocode** -- add the same block under `mcpServers` in the MCP settings JSON of your editor.

### Cline / Roo Code / Kilocode

For editors with MCP support, after adding the `mcpServers` block to your settings, download the slash command workflows:

```bash
mkdir -p .clinerules/workflows
curl -sL https://raw.githubusercontent.com/clay-good/spec-gen/main/examples/cline-workflows/spec-gen-analyze-codebase.md -o .clinerules/workflows/spec-gen-analyze-codebase.md
curl -sL https://raw.githubusercontent.com/clay-good/spec-gen/main/examples/cline-workflows/spec-gen-check-spec-drift.md -o .clinerules/workflows/spec-gen-check-spec-drift.md
curl -sL https://raw.githubusercontent.com/clay-good/spec-gen/main/examples/cline-workflows/spec-gen-plan-refactor.md -o .clinerules/workflows/spec-gen-plan-refactor.md
curl -sL https://raw.githubusercontent.com/clay-good/spec-gen/main/examples/cline-workflows/spec-gen-execute-refactor.md -o .clinerules/workflows/spec-gen-execute-refactor.md
```

Available commands:

| Command | What it does |
|---------|-------------|
| `/spec-gen-analyze-codebase` | Runs `analyze_codebase`, summarises the results (project type, file count, top 3 refactor issues, detected domains), shows the call graph highlights, and suggests next steps. |
| `/spec-gen-check-spec-drift` | Runs `check_spec_drift`, presents issues by severity (gap / stale / uncovered / orphaned-spec), shows per-kind remediation commands, and optionally drills into affected file signatures. |
| `/spec-gen-plan-refactor` | Runs static analysis, picks the highest-priority target with coverage gate, assesses impact and call graph, then writes a detailed plan to `.spec-gen/refactor-plan.md`. No code changes. |
| `/spec-gen-execute-refactor` | Reads `.spec-gen/refactor-plan.md`, establishes a green baseline, and applies each planned change one at a time -- with diff verification and test run after every step. Optional final step covers dead-code detection and naming alignment (requires `spec-gen generate`). |

All four commands ask which directory to use, call the MCP tools directly, and guide you through the results without leaving the editor. They work in any editor that supports the `.clinerules/workflows/` convention.

### Claude Skills

For Claude Code, copy the skill files to `.claude/skills/` in your project:

```bash
mkdir -p .claude/skills
curl -sL https://raw.githubusercontent.com/clay-good/spec-gen/main/skills/claude-spec-gen.md -o .claude/skills/claude-spec-gen.md
curl -sL https://raw.githubusercontent.com/clay-good/spec-gen/main/skills/openspec-skill.md -o .claude/skills/openspec-skill.md
```

**Spec-Gen Skill** (`claude-spec-gen.md`) — Code archaeology skill that guides Claude through:
- Project type detection and domain identification
- Entity extraction, service analysis, API extraction
- Architecture synthesis and OpenSpec spec generation

**OpenSpec Skill** (`openspec-skill.md`) — Skill for working with OpenSpec specifications:
- Semantic spec search with `search_specs`
- List domains with `list_spec_domains`
- Navigate requirements and scenarios

### Tools

All tools run on **pure static analysis** -- no LLM quota consumed.

**Analysis**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `analyze_codebase` | Run full static analysis: repo structure, dependency graph, call graph (hub functions, entry points, layer violations), and top refactoring priorities. Results cached for 1 hour (`force: true` to bypass). | No |
| `get_call_graph` | Hub functions (high fan-in), entry points (no internal callers), and architectural layer violations. Supports TypeScript, JavaScript, Python, Go, Rust, Ruby, Java. | Yes |
| `get_signatures` | Compact function/class signatures per file. Filter by path substring with `filePattern`. Useful for understanding a module's public API without reading full source. | Yes |
| `get_duplicate_report` | Detect duplicate code: Type 1 (exact clones), Type 2 (structural -- renamed variables), Type 3 (near-clones with Jaccard similarity >= 0.7). Groups sorted by impact. | Yes |

**Refactoring**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `get_refactor_report` | Prioritized list of functions with structural issues: unreachable code, hub overload (high fan-in), god functions (high fan-out), SRP violations, cyclic dependencies. | Yes |
| `analyze_impact` | Deep impact analysis for a specific function: fan-in/fan-out, upstream call chain, downstream critical path, risk score (0-100), blast radius, and recommended strategy. | Yes |
| `get_low_risk_refactor_candidates` | Safest functions to refactor first: low fan-in, low fan-out, not a hub, no cyclic involvement. Best starting point for incremental, low-risk sessions. | Yes |
| `get_leaf_functions` | Functions that make no internal calls (leaves of the call graph). Zero downstream blast radius. Sorted by fan-in by default -- most-called leaves have the best unit-test ROI. | Yes |
| `get_critical_hubs` | Highest-impact hub functions ranked by criticality. Each hub gets a stability score (0-100) and a recommended approach: extract, split, facade, or delegate. | Yes |
| `get_god_functions` | Detect god functions (high fan-out, likely orchestrators) in the project or in a specific file, and return their call-graph neighborhood. Use this to identify which functions need to be refactored and understand what logical blocks to extract. | Yes |

**Navigation**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `get_subgraph` | Depth-limited subgraph centred on a function. Direction: `downstream` (what it calls), `upstream` (who calls it), or `both`. Output as JSON or Mermaid diagram. | Yes |
| `get_architecture_overview` | High-level cluster map: roles (entry layer, orchestrator, core utilities, API layer, internal), inter-cluster dependencies, global entry points, and critical hubs. No LLM required. | Yes |
| `get_function_skeleton` | Noise-stripped view of a source file: logs, inline comments, and non-JSDoc block comments removed. Signatures, control flow, return/throw, and call expressions preserved. Returns reduction %. | No |
| `suggest_insertion_points` | Semantic search over the vector index to find the best existing functions to extend or hook into when implementing a new feature. Returns ranked candidates with role and strategy. | Yes (+ `--embed`) |
| `search_code` | Natural-language semantic search over indexed functions. Returns the closest matches by meaning with similarity score. Useful for navigating unfamiliar codebases. | Yes (+ `--embed`) |

**Specs**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `get_mapping` | Requirement->function mapping produced by `spec-gen generate`. Shows which functions implement which spec requirements, confidence level, and orphan functions with no spec coverage. | Yes (generate) |
| `check_spec_drift` | Detect code changes not reflected in OpenSpec specs. Compares git-changed files against spec coverage maps. Issues: gap / stale / uncovered / orphaned-spec / adr-gap. | Yes (generate) |
| `search_specs` | Semantic search over OpenSpec specifications to find requirements, design notes, and architecture decisions by meaning. Returns linked source files for graph highlighting. Use this when asked "which spec covers X?" or "where should we implement Z?". Requires a spec index built with `spec-gen analyze --embed` or `--reindex-specs`. | Yes (generate) |
| `list_spec_domains` | List all OpenSpec domains available in this project. Use this to discover what domains exist before doing a targeted `search_specs` call. | Yes (generate) |

### Parameters

**`analyze_codebase`**
```
directory  string   Absolute path to the project directory
force      boolean  Force re-analysis even if cache is fresh (default: false)
```

**`get_refactor_report`**, **`get_call_graph`**
```
directory  string   Absolute path to the project directory
```

**`get_signatures`**
```
directory    string   Absolute path to the project directory
filePattern  string   Optional path substring filter (e.g. "services", ".py")
```

**`get_subgraph`**
```
directory     string   Absolute path to the project directory
functionName  string   Function name to centre on (case-insensitive partial match)
direction     string   "downstream" | "upstream" | "both"  (default: "downstream")
maxDepth      number   BFS traversal depth limit  (default: 3)
format        string   "json" | "mermaid"  (default: "json")
```

*Note: If no exact name match is found, `get_subgraph` falls back to semantic search (when a vector index is available) to find the most similar function.*

**`get_mapping`**
```
directory    string    Absolute path to the project directory
domain       string    Optional domain filter (e.g. "auth", "crawler")
orphansOnly  boolean   Return only orphan functions (default: false)
```

**`get_duplicate_report`**
```
directory  string   Absolute path to the project directory
```

**`check_spec_drift`**
```
directory  string    Absolute path to the project directory
base       string    Git ref to compare against (default: auto-detect main/master)
files      string[]  Specific files to check (default: all changed files)
domains    string[]  Only check these spec domains (default: all)
failOn     string    Minimum severity to report: "error" | "warning" | "info" (default: "warning")
maxFiles   number    Max changed files to analyze (default: 100)
```

**`list_spec_domains`**
```
directory  string   Absolute path to the project directory
```

**`analyze_impact`**
```
directory  string   Absolute path to the project directory
symbol     string   Function or method name (exact or partial match)
depth      number   Traversal depth for upstream/downstream chains (default: 2)
```

*Note: If no exact name match is found, `analyze_impact` falls back to semantic search (when a vector index is available) to find the most similar function.*

**`get_low_risk_refactor_candidates`**
```
directory    string   Absolute path to the project directory
limit        number   Max candidates to return (default: 5)
filePattern  string   Optional path substring filter (e.g. "services", ".py")
```

**`get_leaf_functions`**
```
directory    string   Absolute path to the project directory
limit        number   Max results to return (default: 20)
filePattern  string   Optional path substring filter
sortBy       string   "fanIn" (default) | "name" | "file"
```

**`get_critical_hubs`**
```
directory  string   Absolute path to the project directory
limit      number   Max hubs to return (default: 10)
minFanIn   number   Minimum fan-in threshold to be considered a hub (default: 3)
```

**`get_architecture_overview`**
```
directory  string   Absolute path to the project directory
```

**`get_function_skeleton`**
```
directory  string   Absolute path to the project directory
filePath   string   Path to the file, relative to the project directory
```

**`get_god_functions`**
```
directory        string   Absolute path to the project directory
filePath         string   Optional: restrict search to this file (relative path)
fanOutThreshold  number   Minimum fan-out to be considered a god function (default: 8)
```

**`suggest_insertion_points`**
```
directory  string   Absolute path to the project directory
query      string   Natural-language description of the feature to implement
limit      number   Max candidates to return (default: 5)
```

**`search_code`**
```
directory  string   Absolute path to the project directory
query      string   Natural-language query, e.g. "authenticate user with JWT"
limit      number   Max results (default: 10)
language   string   Filter by language: "TypeScript" | "Python" | "Go" | ...
minFanIn   number   Only return functions with at least this many callers
```

**`search_specs`**
```
directory  string   Absolute path to the project directory
query      string   Natural language query, e.g. "email validation workflow"
limit      number   Maximum number of results to return (default: 10)
domain     string   Filter by domain name (e.g. "auth", "analyzer")
section    string   Filter by section type: "requirements" | "purpose" | "design" | "architecture" | "entities"
```

### Typical workflow

**Scenario A -- Initial exploration**
```
1. analyze_codebase({ directory })                    # repo structure + call graph + top issues
2. get_call_graph({ directory })                      # hub functions + layer violations
3. get_duplicate_report({ directory })                # clone groups to consolidate
4. get_refactor_report({ directory })                 # prioritized refactoring candidates
```

**Scenario B -- Targeted refactoring**
```
1. analyze_impact({ directory, symbol: "myFunction" })       # risk score + blast radius + strategy
2. get_subgraph({ directory, functionName: "myFunction",     # Mermaid call neighbourhood
                  direction: "both", format: "mermaid" })
3. get_low_risk_refactor_candidates({ directory,             # safe entry points to extract first
                                      filePattern: "myFile" })
4. get_leaf_functions({ directory, filePattern: "myFile" })  # zero-risk extraction targets
```

**Scenario C -- Spec maintenance**
```
1. check_spec_drift({ directory })                    # code changes not reflected in specs
2. get_mapping({ directory, orphansOnly: true })      # functions with no spec coverage
```

## Interactive Graph Viewer

`spec-gen view` launches a local React app that visualises your codebase analysis and lets you explore spec requirements side-by-side with the dependency graph.

```bash
# Run analysis first (if not already done)
spec-gen analyze

# Launch the viewer (opens browser automatically)
spec-gen view

# Options
spec-gen view --port 4000          # custom port (default: 5173)
spec-gen view --host 0.0.0.0       # expose on LAN
spec-gen view --no-open            # don't open browser automatically
spec-gen view --analysis <path>    # custom analysis dir (default: .spec-gen/analysis/)
spec-gen view --spec <path>        # custom spec dir (default: ./openspec/specs/)
```

### Views

| View | Description |
|------|-------------|
| **Clusters** | Colour-coded architectural clusters with expandable member nodes |
| **Flat** | Force-directed dependency graph (all nodes) |
| **Architecture** | High-level cluster map: role-coloured boxes, inter-cluster dependency arrows |

### Diagram Chat

The right sidebar includes a **Diagram Chat** panel powered by an LLM agent. The chat can access all analysis tools and interact with the graph:

- Ask questions about your codebase in natural language
- Graph functions and requirements mentioned in answers are automatically highlighted
- Clusters containing highlighted nodes auto-expand to reveal the nodes
- Select a node in the chat to view its details tab

Example queries:
- "What are the most critical functions?"
- "Where would I add a new API endpoint?"
- "Show me the impact of changing the authentication service"

The chat requires an LLM API key (same provider configuration as `spec-gen generate`). Viewer-only operations like graph browsing, skeleton view, and search do not require an API key.

### Right panel tabs (select a node to activate)

| Tab | Content |
|-----|---------|
| **Node** | File metadata: exports, language, score |
| **Links** | Direct callers and callees |
| **Blast** | Downstream impact radius |
| **Spec** | Requirements linked to the selected file -- body, domain, confidence |
| **Skeleton** | Noise-stripped source: logs and comments removed, structure preserved |
| **Info** | Global stats and top-ranked files |

### Search

The search bar filters all three views simultaneously (text match on name, path, exports, tags). If a vector index was built with `--embed`, typing >= 3 characters also queries the semantic index and shows the top 5 function matches in a dropdown.

### Automatic data loading

The viewer auto-loads all available data on startup:

| Endpoint | Source | Required? |
|----------|--------|-----------|
| `/api/dependency-graph` | `.spec-gen/analysis/dependency-graph.json` | Yes |
| `/api/llm-context` | `.spec-gen/analysis/llm-context.json` | No |
| `/api/refactor-priorities` | `.spec-gen/analysis/refactor-priorities.json` | No |
| `/api/mapping` | `.spec-gen/analysis/mapping.json` | No |
| `/api/spec-requirements` | `openspec/specs/**/*.md` + `mapping.json` | No |
| `/api/skeleton?file=` | Source file on disk | No |
| `/api/search?q=` | `.spec-gen/analysis/vector-index/` | No (`--embed`) |

Run `spec-gen generate` to produce `mapping.json` and the spec files. Once present, the **Spec** tab shows the full requirement body for each selected file.

### View Options

```bash
spec-gen view [options]
  --analysis <path>    Analysis directory (default: .spec-gen/analysis/)
  --spec <path>        Spec files directory (default: ./openspec/specs/)
  --port <n>           Port (default: 5173)
  --host <host>        Bind host (default: 127.0.0.1; use 0.0.0.0 for LAN)
  --no-open            Skip automatic browser open
```

## Output

spec-gen writes to the OpenSpec directory structure:

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

Static analysis output is stored in `.spec-gen/analysis/`:

| File | Description |
|------|-------------|
| `repo-structure.json` | Project structure and metadata |
| `dependency-graph.json` | Import/export relationships |
| `llm-context.json` | Context prepared for LLM (signatures, call graph) |
| `dependencies.mermaid` | Visual dependency graph |
| `SUMMARY.md` | Human-readable analysis summary |
| `call-graph.json` | Function-level call graph (7 languages) |
| `refactor-priorities.json` | Refactoring issues by file and function |
| `mapping.json` | Requirement->function mapping (produced by `generate`) |
| `vector-index/` | LanceDB semantic index (produced by `--embed`) |

`spec-gen analyze` also writes **`ARCHITECTURE.md`** to your project root -- a Markdown overview of module clusters, entry points, and critical hubs, refreshed on every run.

## Semantic Search

`spec-gen analyze --embed` builds a vector index over all functions in the call graph, enabling natural-language search via the `search_code` and `suggest_insertion_points` MCP tools, and the search bar in the viewer.

### Embedding configuration

Provide an OpenAI-compatible embedding endpoint (Ollama, OpenAI, Mistral, etc.) via environment variables or `.spec-gen/config.json`:

**Environment variables:**
```bash
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=sk-...         # optional for local servers

# Then run:
spec-gen analyze --embed
```

**Config file (`.spec-gen/config.json`):**
```json
{
  "embedding": {
    "baseUrl": "http://localhost:11434/v1",
    "model": "nomic-embed-text"
  }
}
```

The index is stored in `.spec-gen/analysis/vector-index/` and is automatically used by the viewer's search bar and the `search_code` / `suggest_insertion_points` MCP tools.

## Configuration

`spec-gen init` creates `.spec-gen/config.json`:

```json
{
  "version": "1.0.0",
  "projectType": "nodejs",
  "openspecPath": "./openspec",
  "analysis": {
    "maxFiles": 500,
    "includePatterns": [],
    "excludePatterns": []
  },
  "generation": {
    "model": "claude-sonnet-4-20250514",
    "domains": "auto"
  }
}
```

### Environment Variables

| Variable | Provider | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | `anthropic` | Anthropic API key |
| `ANTHROPIC_API_BASE` | `anthropic` | Custom base URL (proxy / self-hosted) |
| `OPENAI_API_KEY` | `openai` | OpenAI API key |
| `OPENAI_API_BASE` | `openai` | Custom base URL (Azure, proxy...) |
| `OPENAI_COMPAT_API_KEY` | `openai-compat` | API key for OpenAI-compatible server |
| `OPENAI_COMPAT_BASE_URL` | `openai-compat` | Base URL, e.g. `https://api.mistral.ai/v1` |
| `GEMINI_API_KEY` | `gemini` | Google Gemini API key |
| `DEBUG` | -- | Enable stack traces on errors |
| `CI` | -- | Auto-detected; enables timestamps in output |

## Requirements

- Node.js 20+
- API key for `generate`, `verify`, and `drift --use-llm` -- set the env var for your chosen provider:
  ```bash
  export ANTHROPIC_API_KEY=sk-ant-...       # Anthropic (default)
  export OPENAI_API_KEY=sk-...              # OpenAI
  export OPENAI_COMPAT_API_KEY=ollama       # OpenAI-compatible local server
  export GEMINI_API_KEY=...                 # Google Gemini
  ```
- `analyze`, `drift`, and `init` require no API key

## Supported Languages

| Language | Signatures | Call Graph |
|----------|-----------|------------|
| TypeScript / JavaScript | Full | Full |
| Python | Full | Full |
| Go | Full | Full |
| Rust | Full | Full |
| Ruby | Full | Full |
| Java | Full | Full |

TypeScript projects get the best results due to richer type information.

## Usage Options

**CLI Tool** (recommended):
```bash
spec-gen init && spec-gen analyze && spec-gen generate && spec-gen drift --install-hook
```

**Claude Code Skill**: Copy `skills/claude-spec-gen.md` to `.claude/skills/` in your project.

**OpenSpec Skill**: Copy `skills/openspec-skill.md` to your OpenSpec skills directory.

**Direct LLM Prompting**: Use `AGENTS.md` as a system prompt for any LLM.

**Programmatic API**: Import spec-gen as a library in your own tools.

## Programmatic API

spec-gen exposes a typed Node.js API for integration into other tools (like [OpenSpec CLI](https://github.com/Fission-AI/OpenSpec)). Every CLI command has a corresponding API function that returns structured results instead of printing to the console.

```bash
npm install spec-gen
```

```typescript
import { specGenAnalyze, specGenDrift, specGenRun } from 'spec-gen';

// Run the full pipeline
const result = await specGenRun({
  rootPath: '/path/to/project',
  adr: true,
  onProgress: (event) => console.log(`[${event.phase}] ${event.step}`),
});
console.log(`Generated ${result.generation.report.filesWritten.length} specs`);

// Check for drift
const drift = await specGenDrift({
  rootPath: '/path/to/project',
  failOn: 'warning',
});
if (drift.hasDrift) {
  console.warn(`${drift.summary.total} drift issues found`);
}

// Static analysis only (no API key needed)
const analysis = await specGenAnalyze({
  rootPath: '/path/to/project',
  maxFiles: 1000,
});
console.log(`Analyzed ${analysis.repoMap.summary.analyzedFiles} files`);
```

### API Functions

| Function | Description | API Key |
|----------|-------------|---------|
| `specGenInit(options?)` | Initialize config and openspec directory | No |
| `specGenAnalyze(options?)` | Run static analysis | No |
| `specGenGenerate(options?)` | Generate specs from analysis | Yes |
| `specGenVerify(options?)` | Verify spec accuracy | Yes |
| `specGenDrift(options?)` | Detect spec-to-code drift | No* |
| `specGenRun(options?)` | Full pipeline: init + analyze + generate | Yes |

\* `specGenDrift` requires an API key only when `llmEnhanced: true`.

All functions accept an optional `onProgress` callback for status updates and throw errors instead of calling `process.exit`. See [src/api/types.ts](src/api/types.ts) for full option and result type definitions.

## Examples

| Example | Description |
|---------|-------------|
| [examples/openspec-analysis/](examples/openspec-analysis/) | Static analysis output from `spec-gen analyze` |
| [examples/openspec-cli/](examples/openspec-cli/) | Specifications generated with `spec-gen generate` |
| [examples/drift-demo/](examples/drift-demo/) | Sample project configured for drift detection |

## Development

```bash
npm install          # Install dependencies
npm run dev          # Development mode (watch)
npm run build        # Build
npm run test:run     # Run tests (1052 unit tests)
npm run typecheck    # Type check
```

1052 unit tests covering static analysis, call graph, refactor analysis, spec mapping, drift detection, LLM enhancement, ADR generation, and the full CLI.

## Links

- [OpenSpec](https://github.com/Fission-AI/OpenSpec) - Spec-driven development framework
- [Architecture](docs/ARCHITECTURE.md) - Internal design and module organization
- [Algorithms](docs/ALGORITHMS.md) - Analysis algorithms
- [OpenSpec Integration](docs/OPENSPEC-INTEGRATION.md) - How spec-gen integrates with OpenSpec
- [OpenSpec Format](docs/OPENSPEC-FORMAT.md) - Spec format reference
- [Philosophy](docs/PHILOSOPHY.md) - "Archaeology over Creativity"
- [Troubleshooting](docs/TROUBLESHOOTING.md) - Common issues and solutions
- [AGENTS.md](AGENTS.md) - LLM system prompt for direct prompting
