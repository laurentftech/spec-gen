## Commands

| Command | Description | API Key |
|---------|-------------|---------|
| `openlore init` | Initialize configuration | No |
| `openlore analyze` | Run static analysis | No |
| `openlore generate` | Generate specs from analysis | Yes |
| `openlore generate --adr` | Also generate Architecture Decision Records | Yes |
| `openlore verify` | Verify spec accuracy | Yes |
| `openlore drift` | Detect spec drift (static) | No |
| `openlore drift --use-llm` | Detect spec drift (LLM-enhanced) | Yes |
| `openlore drift --suggest-tests` | After drift, list test files covering affected domains | No |
| `openlore audit` | Report spec coverage gaps: uncovered functions, hub gaps, stale domains | No |
| `openlore test` | Generate spec-driven tests (Vitest / Playwright / pytest / GTest / Catch2) | No |
| `openlore test --coverage` | Report which spec scenarios have corresponding tests | No |
| `openlore digest` | Plain-English summary of all specs for human review | No |
| `openlore decisions` | Manage architectural decisions: list, approve, reject, sync to specs and ADRs | No |
| `openlore decisions --install-hook` | Install the pre-commit hook that gates commits until decisions are reviewed | No |
| `openlore run` | Full pipeline: init, analyze, generate | Yes |
| `openlore view` | Launch interactive graph & spec viewer in the browser | No |
| `openlore setup` | Install workflow skills into the project (Vibe, Cline, GSD, BMAD) | No |
| `openlore mcp` | Start MCP server (stdio, for Cline / Claude Code) | No |
| `openlore doctor` | Check environment and configuration for common issues | No |
| `openlore refresh-stories` | Refresh story files with latest structural context after each commit | No |

### Global Options

```bash
--api-base <url>       # Custom LLM API base URL (proxy / self-hosted)
--insecure             # Disable SSL certificate verification
--config <path>        # Config file path (default: .openlore/config.json)
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
openlore drift [options]
  --base <ref>           # Git ref to compare against (default: auto-detect)
  --files <paths>        # Specific files to check (comma-separated)
  --domains <list>       # Only check specific domains
  --use-llm              # LLM semantic analysis
  --json                 # JSON output
  --fail-on <severity>   # Exit non-zero threshold: error, warning, info
  --max-files <n>        # Max changed files to analyze (default: 100)
  --verbose              # Show detailed issue information
  --suggest-tests        # List test files covering drifted domains
  --install-hook         # Install pre-commit hook
  --uninstall-hook       # Remove pre-commit hook
```

### Generate Options

```bash
openlore generate [options]
  --model <name>         # LLM model to use
  --dry-run              # Preview without writing
  --domains <list>       # Only generate specific domains
  --merge                # Merge with existing specs
  --no-overwrite         # Skip existing files
  --adr                  # Also generate ADRs
  --adr-only             # Generate only ADRs
  --force                # Re-run all LLM stages, clear generation cache, remove stale domains
  --analysis <path>      # Path to existing analysis directory
  --output-dir <path>    # Override openspec output location
  -y, --yes              # Skip confirmation prompts
```

### Run Options

```bash
openlore run [options]
  --force                # Reinitialize even if config exists
  --reanalyze            # Force fresh analysis even if recent exists
  --model <name>         # LLM model to use for generation
  --dry-run              # Show what would be done without making changes
  -y, --yes              # Skip all confirmation prompts
  --max-files <n>        # Maximum files to analyze (default: 500)
  --adr                  # Also generate Architecture Decision Records
```

### Analyze Options

```bash
openlore analyze [options]
  --output <path>        # Output directory (default: .openlore/analysis/)
  --max-files <n>        # Max files (default: 500)
  --include <glob>       # Additional include patterns
  --exclude <glob>       # Additional exclude patterns
  --force                # Force re-analysis (bypass 1-hour cache)
  --ai-configs           # Generate AI tool config files (CLAUDE.md, .cursorrules, .clinerules/openlore.md,
                         #   .github/copilot-instructions.md, .windsurf/rules.md, .vibe/skills/openlore.md)
                         #   Safe to re-run — skips files that already exist, marks pre-existing ones.
  --no-embed             # Skip building the semantic vector index (index is built by default when embedding is configured)
  --reindex-specs        # Re-index OpenSpec specs into the vector index without re-running full analysis
```

### Setup Options

```bash
openlore setup [options]
  --tools <list>   Comma-separated tools to install: vibe, cline, claude, opencode, gsd, bmad, omoa (default: interactive prompt)
  --force          Overwrite existing files (use after upgrading openlore)
  --dir <path>     Project root directory (default: current directory)
```

Installs workflow skills from the openlore package into the project. Skills are static assets — identical across projects — so this command only needs to be run once at project onboarding and again after upgrading openlore.

Files installed:

| Tool | Destination | Content |
|------|-------------|---------|
| `vibe` | `.vibe/skills/openlore-{name}/SKILL.md` | 8 skills |
| `cline` | `.clinerules/workflows/openlore-{name}.md` | 7 workflows |
| `claude` | `.claude/skills/openlore-{name}/SKILL.md` + decisions pre-commit hook | 8 skills + commit gate |
| `opencode` | `.opencode/skills/openlore-{name}/SKILL.md` + `.opencode/plugins/agent-guard.ts` | 8 skills + guard plugin |
| `gsd` | `.claude/commands/gsd/openlore-{name}.md` | 2 commands |
| `bmad` | `_bmad/openlore/{agents,tasks}/` | 2 agents, 4 tasks |
| `omoa` | `.opencode/plugins/` + `.opencode/prompts/` | 4 SDD plugins + Sisyphus prompt (oh-my-openagent) |

The `omoa` option is **auto-detected and pre-checked** in the interactive prompt when oh-my-openagent is found in the project or user config.

Never overwrites existing files. Combine with `analyze --ai-configs` for a complete agent setup:

```bash
openlore analyze --ai-configs   # project-specific context files
openlore setup                   # workflow skills
```

### Decisions Options

```bash
openlore decisions [options]
  --list                 # List decisions, optionally filtered by --status
  --status <status>      # Filter by status: draft, consolidated, verified, approved, synced, phantom
                         # Note: synced/rejected/phantom are purged from store after --sync
  --approve <id>         # Approve a decision by ID (blocked if already synced)
  --reject <id>          # Reject a decision by ID
  --reason <text>        # Rejection reason (used with --reject)
  --sync                 # Write approved decisions into specs and ADRs, then purge inactive entries
  --dry-run              # Preview sync without writing files
  --gate                 # Run commit gate check (reads pending.json, no LLM — used by pre-commit hook)
                         # Gate reason codes: verified | approved_not_synced |
                         #   drafts_pending_consolidation | no_decisions_recorded
  --consolidate          # Manually trigger LLM consolidation + diff verification of drafts
  --json                 # Machine-readable output
  --uninstall-hook       # Remove decisions pre-commit hook (install via: openlore setup --tools claude)
```

### Verify Options

```bash
openlore verify [options]
  --samples <n>          # Files to verify (default: 5)
  --threshold <0-1>      # Minimum score to pass (default: 0.7)
  --files <paths>        # Specific files to verify
  --domains <list>       # Only verify specific domains
  --verbose              # Show detailed prediction vs actual comparison
  --json                 # JSON output
```

### Doctor

`openlore doctor` runs a self-diagnostic and surfaces actionable fixes when something is misconfigured or missing:

```bash
openlore doctor          # Run all checks
openlore doctor --json   # JSON output for scripting
```

Checks performed:

| Check | What it looks for |
|-------|------------------|
| Node.js version | ≥ 20 required |
| Git repository | `.git` directory and `git` binary on PATH |
| openlore config | `.openlore/config.json` exists and is parseable |
| Analysis artifacts | `repo-structure.json` freshness (warns if >24h old) |
| OpenSpec directory | `openspec/specs/` exists |
| LLM provider | API key or `claude` CLI detected |
| Disk space | Warns < 500 MB, fails < 200 MB |

Run `openlore doctor` whenever setup instructions aren't working — it tells you exactly what to fix and how.

