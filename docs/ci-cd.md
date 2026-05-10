## CI/CD Integration

spec-gen is designed to run in automated pipelines. The deterministic commands (`init`, `analyze`, `drift`, `test`, `digest`) need no API key and produce consistent results.

### Pre-Commit Hook

spec-gen provides two pre-commit hooks that address spec alignment from opposite directions:

| Hook | Direction | Speed | Installed via |
|------|-----------|-------|---------------|
| **Drift** | Reactive — code changed without spec | Milliseconds, no API key | `spec-gen drift --install-hook` |
| **Decisions gate** | Proactive — pending decisions await review | Instant, no LLM | `spec-gen setup --tools claude` |

**Drift hook** — blocks commits when code changes are not reflected in existing specs:

```bash
spec-gen drift --install-hook     # Install
spec-gen drift --uninstall-hook   # Remove
```

**Decisions gate** — blocks commits until all recorded architectural decisions have been reviewed and approved. No LLM at commit time: consolidation runs in the background each time an agent calls `record_decision`, so by the time the hook fires, decisions are already verified.

```bash
spec-gen setup --tools claude         # Install (also installs Claude Code skills)
spec-gen decisions --uninstall-hook   # Remove decisions hook only
```

When the gate blocks, the JSON output includes a `reason` field:

| Reason | Meaning | Action |
|--------|---------|--------|
| `verified` | Decisions consolidated and verified — await human review | Present to user, call `approve_decision` / `reject_decision`, then `--sync` |
| `approved_not_synced` | Decisions approved but not written to specs yet | Run `spec-gen decisions --sync`, retry commit |
| `drafts_pending_consolidation` | Drafts recorded but consolidation never ran | Run `spec-gen decisions --consolidate --gate` |
| `no_decisions_recorded` | Source files staged but no decisions recorded | Run `spec-gen decisions --consolidate --gate` for fallback extraction |

The gate uses a sentinel file (`.git/SPEC_GEN_GATE_RAN`) written by the pre-commit hook and checked by the post-commit hook. If a commit bypasses the gate via `--no-verify`, the post-commit hook detects the missing sentinel and logs a warning.

**How they relate**: they address different failure modes and do not substitute for each other.

The decisions gate asks: *"has this architectural choice been reviewed by a human?"* It operates on decisions recorded during development — it has no knowledge of which spec files cover which source files.

The drift hook asks: *"has this source file's spec coverage been kept up to date?"* It compares git-changed files against each spec's source file list — it has no knowledge of recorded decisions.

A commit can trigger drift without any decisions pending (a pure refactor touches a spec-covered file). A commit can have decisions synced without satisfying drift (syncing a decision appends a new requirement but does not update the spec's source file coverage metadata). Run both: decisions for design governance, drift as a coverage staleness check.

Pending decisions are stored in `.spec-gen/decisions/pending.json` (auto-added to `.gitignore` on install).

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

