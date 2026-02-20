# spec-gen

> Reverse-engineer OpenSpec specifications from existing codebases — then keep them in sync as code evolves.

**"Archaeology over Creativity"** — Extract the truth of what your code does, grounded in static analysis. Not what you imagine it should do.

## Why This Exists

Most real-world software has no specification. The code *is* the spec — scattered across thousands of files, tribal knowledge, and stale documentation. When teams adopt AI-assisted development (Claude Code, Cursor, Copilot), the velocity of code change accelerates, but the understanding of *what the system is supposed to do* doesn't keep up.

**spec-gen bridges this gap.** It reverse-engineers [OpenSpec](https://github.com/Fission-AI/OpenSpec) specifications from existing codebases, then provides continuous drift detection to ensure specs stay in sync as code evolves.

### The Brownfield Problem

Greenfield projects can write specs first. But what about the 99% of teams with existing systems?

- `openspec init` creates empty scaffolding — you still have to write everything
- Manually documenting thousands of lines of existing logic is tedious and error-prone
- By the time specs are written, the code has already changed

**spec-gen automates the reverse-engineering process and enforces ongoing accuracy.**

## Where spec-gen Fits: The AI Development Workflow

For teams using Claude Code and OpenSpec for spec-driven development, spec-gen fills a critical role across three phases:

```
┌─────────────────────────────────────────────────────────────────┐
│                    AI Development Workflow                       │
│                                                                 │
│   PLAN                    REFLECT                ACT            │
│   Context Engineering     Compound Learning      Spec-Driven    │
│                                                  Execution      │
│   ┌─────────────────┐    ┌────────────────┐    ┌─────────────┐ │
│   │ spec-gen        │    │ spec-gen       │    │ OpenSpec     │ │
│   │ analyze         │───>│ drift          │───>│ specs guide  │ │
│   │                 │    │                │    │ development  │ │
│   │ Discovery:      │    │ Learning:      │    │              │ │
│   │ - File walker   │    │ - What changed │    │ Execution:   │ │
│   │ - Dep graph     │    │ - What drifted │    │ - Specs as   │ │
│   │ - Domain        │    │ - What's stale │    │   contracts  │ │
│   │   clustering    │    │ - What's new   │    │ - AI reads   │ │
│   │ - Significance  │    │                │    │   specs for  │ │
│   │   scoring       │    │ Feed insights  │    │   context    │ │
│   │                 │    │ back into      │    │ - Specs      │ │
│   │ Build better    │    │ specs          │    │   constrain  │ │
│   │ inputs for AI   │    │                │    │   AI output  │ │
│   └─────────────────┘    └────────────────┘    └─────────────┘ │
│                                                                 │
│   No API key needed       Deterministic or       OpenSpec +     │
│   Pure static analysis    LLM-enhanced           Claude Code    │
└─────────────────────────────────────────────────────────────────┘
```

### Phase 1: Plan (Context Engineering)

**spec-gen analyze** builds a rich understanding of your codebase through pure static analysis — no API key needed:

- Discovers files, respecting .gitignore, scoring each by significance
- Parses imports/exports to build a dependency graph
- Clusters related files into business domains automatically
- Produces structured context that makes LLM generation dramatically better

This is *context engineering* — making better inputs through extensive research, discovery, and organization.

### Phase 2: Reflect (Compound Learning)

**spec-gen drift** answers: "What did we learn from this?" After every code change, drift detection tells you:

- Which code changed but specs weren't updated (gaps)
- Which specs reference deleted or renamed files (stale)
- Which new files have no spec coverage (uncovered)
- Which specs reference files that no longer exist (orphaned)

This creates a compound learning loop — every change feeds back into better specs, which feed back into better AI context.

### Phase 3: Act (Spec-Driven Execution)

**OpenSpec specs** become the contract that guides development. When Claude Code reads your specs, it understands:

- What the system is supposed to do (requirements with SHALL/MUST/SHOULD)
- How it should behave (Given/When/Then scenarios)
- Where things are implemented (technical notes with file paths)

Specs constrain AI output. Instead of guessing, the AI builds against a verified specification.

## Quick Start

```bash
# Install
git clone https://github.com/clay-good/spec-gen
cd spec-gen
npm install && npm run build && npm link

# Navigate to your project
cd /path/to/your-project

# Run the full pipeline
spec-gen init       # Initialize configuration
spec-gen analyze    # Static analysis (no API key needed)
spec-gen generate   # Generate specs (requires API key)
spec-gen verify     # Verify accuracy
spec-gen drift      # Check for spec drift
```

## Requirements

- **Node.js 20+**
- **API Key** (for generate, verify, and drift --use-llm):
  ```bash
  export ANTHROPIC_API_KEY=sk-ant-...
  # or
  export OPENAI_API_KEY=sk-...
  ```

> **Note**: `analyze`, `drift` (default mode), and `init` require no API key. Only spec generation, verification, and LLM-enhanced drift detection need one.

## Deterministic vs. LLM-Enhanced

spec-gen distinguishes between two modes of operation:

| | Deterministic (Default) | LLM-Enhanced |
|---|---|---|
| **API key required** | No | Yes |
| **Speed** | Fast (milliseconds) | Slower (seconds per LLM call) |
| **Commands** | `analyze`, `drift`, `init` | `generate`, `verify`, `drift --use-llm` |
| **How it works** | Static analysis, git diffing, pattern matching | Sends code context to Claude/GPT for semantic understanding |
| **Reproducibility** | Identical results every run | May vary between runs |
| **Best for** | CI pipelines, pre-commit hooks, quick checks | Initial spec generation, reducing false positives, deep analysis |

**The default is always deterministic.** You opt into LLM features explicitly when you need deeper understanding.

### When to Use `--use-llm` with Drift Detection

Static drift detection catches structural changes — file X changed, spec Y wasn't updated. But it can't tell whether the change actually affects spec-documented behavior. A variable rename, a comment change, or an internal refactor triggers the same alert as a genuine behavior change.

`--use-llm` post-processes gap issues by sending each file's diff and its matching spec to the LLM:

```bash
# Static mode (default) — fast, deterministic, great for CI
spec-gen drift

# LLM-enhanced — reduces false positives by classifying changes semantically
spec-gen drift --use-llm
```

The LLM classifies each gap as either:
- **Relevant**: The change affects spec-documented behavior (keeps the alert)
- **Not relevant**: Internal change like refactoring, formatting, or comments (downgrades to info)

This means fewer false alerts and more signal when specs genuinely need updating.

## Drift Detection In Action

Here's what spec drift detection looks like on a real project:

```bash
$ spec-gen drift

  Spec Drift Detection

  ✓ Analyzing git changes...
  ℹ Base ref: main
  ℹ Branch: feature/add-notifications
  ℹ Changed files: 12

  ✓ Loading spec mappings...
  ℹ Spec domains: 6
  ℹ Mapped source files: 34

  ⚡ Detecting drift...

   Issues Found: 4

   ✗ [ERROR] gap: src/services/user-service.ts
      Spec: openspec/specs/user/spec.md
      File `src/services/user-service.ts` changed (+45/-12 lines) but spec `openspec/specs/user/spec.md` was not updated
      +45/-12 lines
      -> Review the user spec to ensure it still accurately describes the behavior in src/services/user-service.ts

   ⚠ [WARNING] gap: src/models/notification.ts
      Spec: openspec/specs/notifications/spec.md
      File `src/models/notification.ts` changed (+28/-3 lines) but spec `openspec/specs/notifications/spec.md` was not updated
      +28/-3 lines
      -> Review the notifications spec to ensure it still accurately describes the behavior in src/models/notification.ts

   ⚠ [WARNING] uncovered: src/services/email-queue.ts
      New file `src/services/email-queue.ts` has no matching spec domain
      +89/-0 lines
      -> Consider adding `src/services/email-queue.ts` to an existing spec domain or creating a new spec

   → [INFO] gap: src/utils/format-date.ts
      Spec: openspec/specs/user/spec.md
      -> Review the user spec to ensure it still accurately describes the behavior in src/utils/format-date.ts

   ──────────────────────────────────────

   Summary:
     Gaps: 3
     Uncovered: 1

  ℹ Duration: 0.3s

  ✗ Drift detected: 1 error, 2 warnings
```

With `--use-llm`, that info-level gap on `format-date.ts` (a utility rename) would be automatically dismissed as not spec-relevant, while the error on `user-service.ts` (new notification triggers) would be enriched with the LLM's reasoning.

### Pre-Commit Hook

Install drift detection as a pre-commit hook to catch drift before it reaches the repository:

```bash
# Install
spec-gen drift --install-hook

# The hook runs in static mode (fast, no LLM, no API key needed)
# Blocks commits when drift is detected at warning level or above

# Remove
spec-gen drift --uninstall-hook
```

### CI/CD Integration

```bash
# In your CI pipeline
spec-gen drift --json --fail-on error

# Only block on errors, allow warnings
spec-gen drift --fail-on error

# Check specific domains
spec-gen drift --domains auth,user
```

## Commands

| Command | Description | API Key |
|---------|-------------|---------|
| `spec-gen` | Full pipeline: init → analyze → generate | Yes |
| `spec-gen init` | Initialize configuration | No |
| `spec-gen analyze` | Run static analysis only | No |
| `spec-gen generate` | Generate specs from analysis | Yes |
| `spec-gen verify` | Verify spec accuracy | Yes |
| `spec-gen drift` | Detect spec drift (static) | No |
| `spec-gen drift --use-llm` | Detect spec drift (LLM-enhanced) | Yes |

### Command Options

**Drift Detection:**
```bash
spec-gen drift [options]
  --base <ref>           # Git ref to compare against (default: auto-detect main/master)
  --files <paths>        # Specific files to check (comma-separated)
  --domains <list>       # Only check specific domains
  --use-llm              # Use LLM for semantic analysis (reduces false positives)
  --json                 # Output results as JSON
  --fail-on <severity>   # Exit non-zero threshold: error, warning, info (default: warning)
  --max-files <n>        # Maximum changed files to analyze (default: 100)
  --verbose              # Show detailed issue information
  --install-hook         # Install as git pre-commit hook
  --uninstall-hook       # Remove pre-commit hook
```

**Full Pipeline:**
```bash
spec-gen [options]
  --force        # Reinitialize even if config exists
  --reanalyze    # Force fresh analysis
  --model <name> # LLM model (default: claude-sonnet-4-20250514)
  --dry-run      # Show what would be done
  -y, --yes      # Skip confirmation prompts
```

**Analyze:**
```bash
spec-gen analyze [options]
  --output <path>   # Output directory (default: .spec-gen/analysis/)
  --max-files <n>   # Maximum files to analyze (default: 500)
  --include <glob>  # Additional patterns to include
  --exclude <glob>  # Additional patterns to exclude
```

**Generate:**
```bash
spec-gen generate [options]
  --model <name>     # LLM model to use
  --dry-run          # Preview without writing
  --domains <list>   # Only generate specific domains
  --merge            # Merge with existing specs
  --no-overwrite     # Skip existing files
```

**Verify:**
```bash
spec-gen verify [options]
  --samples <n>      # Number of files to verify (default: 5)
  --threshold <0-1>  # Minimum score to pass (default: 0.7)
  --verbose          # Show detailed comparison
  --json             # Output as JSON
```

## How It Works

### 1. Static Analysis (No API Key)

- **File Discovery**: Walks the directory tree, respecting .gitignore
- **Significance Scoring**: Ranks files by importance (schemas > services > utilities)
- **Import/Export Parsing**: Builds a dependency graph
- **Cluster Detection**: Groups related files into business domains

### 2. LLM Generation (API Key Required)

Using the analysis as context, spec-gen queries an LLM to extract specifications:

- **Stage 1**: Project Survey — Quick categorization
- **Stage 2**: Entity Extraction — Core data models
- **Stage 3**: Service Analysis — Business logic
- **Stage 4**: API Extraction — HTTP endpoints
- **Stage 5**: Architecture Synthesis — Overall structure

### 3. Verification

Tests generated specs by predicting file contents from specs alone:

- Selects files NOT used in generation
- LLM predicts what each file should contain
- Compares predictions to actual code
- Reports accuracy score and identifies gaps

### 4. Drift Detection

Compares git changes against spec file mappings to find divergence:

- **Gap**: Code changed but its spec wasn't updated
- **Stale**: Spec references deleted or renamed files
- **Uncovered**: New files with no matching spec domain
- **Orphaned**: Spec declares files that no longer exist

## Output

spec-gen writes directly to OpenSpec's structure:

```
openspec/
├── config.yaml              # Project context and metadata
└── specs/
    ├── overview/spec.md     # System overview
    ├── user/spec.md         # Domain: User management
    ├── order/spec.md        # Domain: Order processing
    ├── auth/spec.md         # Domain: Authentication
    ├── architecture/spec.md # System architecture
    └── api/spec.md          # API specification
```

Each spec follows OpenSpec conventions:
- Requirements with RFC 2119 keywords (SHALL, MUST, SHOULD)
- Scenarios in Given/When/Then format
- Technical notes linking to implementation files
- Source file declarations for drift detection mapping

### Analysis Artifacts (.spec-gen/analysis/)

| File | Description |
|------|-------------|
| `repo-structure.json` | Project structure and metadata |
| `dependency-graph.json` | Import/export relationships |
| `llm-context.json` | Context prepared for LLM |
| `dependencies.mermaid` | Visual dependency graph |
| `SUMMARY.md` | Human-readable analysis |

## Configuration

spec-gen creates `.spec-gen/config.json`:

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

## Usage Options

spec-gen provides 4 ways to reverse-engineer specifications:

### Option 1: CLI Tool (Recommended)

The full-featured command-line tool with static analysis, LLM generation, verification, and drift detection.

```bash
spec-gen init && spec-gen analyze && spec-gen generate && spec-gen drift --install-hook
```

### Option 2: Claude Code Skill

For Claude Code users, copy `skills/claude-spec-gen.md` to `.claude/skills/` in your project:

```
"Run spec-gen on this codebase"
"Generate OpenSpec specifications for the user domain"
"Check for spec drift"
```

### Option 3: OpenSpec Native Skill

For OpenSpec's built-in skill system:

```bash
cp skills/openspec-skill.md /path/to/openspec/skills/
```

### Option 4: Direct LLM Prompting

Copy `AGENTS.md` as a system prompt for any LLM (ChatGPT, Claude, etc.):

```
1. Paste contents of AGENTS.md
2. Ask: "Analyze this codebase and generate OpenSpec specs"
3. Provide file contents or let it explore
```

## Supported Languages

| Language | Support Level |
|----------|---------------|
| JavaScript/TypeScript | Full |
| Python | Basic |
| Go | Basic |

The tool works best with TypeScript projects due to richer type information.

## Examples

| Example | Description |
|---------|-------------|
| [examples/openspec-analysis/](examples/openspec-analysis/) | Static analysis output from running `spec-gen analyze` on the OpenSpec CLI |
| [examples/openspec-cli/](examples/openspec-cli/) | Full OpenSpec specifications generated with `spec-gen generate` |
| [examples/drift-demo/](examples/drift-demo/) | A sample project configured for drift detection |

## Development

```bash
npm install          # Install dependencies
npm run dev          # Development mode (watch)
npm run build        # Build
npm run test:run     # Run tests (864 unit tests)
npm run typecheck    # Type check
```

### Test Suite

- **864 unit tests** covering all modules including drift detection, spec mapping, LLM enhancement, and static analysis
- **27 end-to-end tests** for drift detection (gap detection, stale specs, uncovered files, orphaned specs, JSON output, pre-commit hooks, domain filtering, LLM flag handling)

## Links

- [OpenSpec](https://github.com/Fission-AI/OpenSpec) — The spec-driven development framework
- [AGENTS.md](AGENTS.md) — LLM system prompt for direct prompting
- [Architecture](docs/ARCHITECTURE.md) — Internal design and module organization
- [Algorithms](docs/ALGORITHMS.md) — Analysis algorithms explained
- [Philosophy](docs/PHILOSOPHY.md) — "Archaeology over Creativity" explained
- [Troubleshooting](docs/TROUBLESHOOTING.md) — Common issues and solutions

## License

[MIT](LICENSE)
