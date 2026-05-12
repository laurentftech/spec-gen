# Refactoring Workflow with openlore

Workflow for using openlore to refactor an existing codebase — particularly
useful for vibe-coded projects with inconsistent naming, dead code, and poor
normalization.

> **MCP shortcut** — If you use Cline or Claude Code, `openlore mcp` exposes
> all analysis steps as tools the AI can call directly, without CLI commands or
> `jq` pipes. Copy the files from `examples/cline-workflows/` into your project's
> `.clinerules/workflows/` and Cline will expose `/openlore-analyze-codebase`,
> `/openlore-plan-refactor`, and `/openlore-execute-refactor` slash commands
> that drive the full loop.
> The MCP equivalents are noted inline throughout this guide.

---

## 1. Initial Setup

```bash
cd your-project
openlore init        # detects project type, creates .openlore/config.json
openlore analyze     # static analysis — no LLM, builds dependency graph
```

**Outputs:**
- `.openlore/config.json` — configuration
- `.openlore/analysis/repo-structure.json` — file significance scores, domain detection
- `.openlore/analysis/dependency-graph.json` — exports, imports, connectivity per file
- `.openlore/analysis/refactor-priorities.json` — **static refactoring candidates** (see §2b)

---

## 1b. Read the Static Refactoring Report  *(no LLM required)*

`analyze` runs a **pure static call graph analysis** (no LLM) and immediately
produces `.openlore/analysis/refactor-priorities.json`. The console output
shows a summary:

```
Refactoring Candidates  (7/266 functions):
  2 hub overload  ·  5 god function

  check_authentication  auth.py      fanOut=15
  crawl_json_api_async  crawler.py   fanOut=14
  t                     i18n.py      fanIn=25
  ...
  → .openlore/analysis/refactor-priorities.json
```

**Issue types detected:**

| Issue | Meaning | Threshold |
|---|---|---|
| `high_fan_in` | Called by too many others — likely a hub utility | fanIn ≥ 8 |
| `high_fan_out` | Calls too many others — likely a god function / orchestrator | fanOut ≥ 8 |
| `multi_requirement` | Implements too many spec requirements — SRP violation | > 2 requirements |
| `in_cycle` | Part of a cyclic call dependency | SCC size > 1 |
| `unreachable` | Not reachable from any entry point and not in any spec | depth = -1 |

**MCP equivalent:** `get_refactor_report({ directory: "/path/to/project" })` — returns the same prioritized list directly to your AI agent, no CLI or `jq` needed.

**Notes on interpretation:**
- `high_fan_out` on an entry point (CLI command, route handler) is expected
  and less urgent than `high_fan_out` on a mid-layer service
- `high_fan_in` on logger or pure-utility functions is suppressed automatically
- Test files are excluded from the analysis
- `unreachable` functions are dead-code candidates, but verify first: they may
  be public API consumed externally, or re-exported from an index file

**At this stage `requirements` is always empty** — the mapping from
requirements to functions is only available after `openlore generate` has run
(see §4). Re-run `analyze` after a generate to get the enriched report.

---

## 2. Generate the Spec

```bash
openlore generate -y
```

**What happens:**
- Stage 1 — surveys the project (tech stack, architecture, suggested domains)
- Stage 2 — extracts business entities from schema/type files (one file at a time)
- Stage 3 — extracts services and operations from logic files; the LLM reports
  `functionName` for each operation (the exact function in the source code)
- Stage 4 — extracts API surface (if applicable)
- Stage 5 — synthesizes architecture overview

**Outputs:**
- `openspec/specs/{domain}/spec.md` — one spec per business domain
- `openspec/specs/overview/spec.md` — system overview with domain table
- `openspec/specs/architecture/spec.md` — layer map and data flow
- `.openlore/analysis/mapping.json` — **requirement → function mapping** (see below)

---

## 3. Validate the Generated Spec

**Before refactoring**, the spec must be reviewed and corrected. An LLM can
misclassify domains, invent requirements, or miss critical operations. Starting
a refactoring from a bad spec will normalize the code toward the wrong target.

### 3a. Automated validation

```bash
openlore verify       # validates specs against source code
```

Reports requirements with no matching code evidence, mismatched domain
assignments, and structural issues.

### 3b. Manual review checklist

For each domain spec (`openspec/specs/{domain}/spec.md`):

- [ ] **Purpose** — does it accurately describe what the domain does?
- [ ] **Entities** — are they real business entities, not framework internals?
- [ ] **Requirements** — do they map to real behaviors in the code?
- [ ] **Domain assignment** — is each service in the right domain?
  (check `confidence: "llm"` in `mapping.json` — heuristic matches need scrutiny)
- [ ] **Missing requirements** — are important operations absent from the spec?

### 3c. Correct the spec

Edit the spec files directly — they are plain Markdown. Corrections to make:

```markdown
# Fix a misclassified domain → move the requirement to the right spec file
# Fix an inaccurate requirement name → rename it (the mapping will update on next generate)
# Add a missing requirement → write it in GIVEN/WHEN/THEN format
# Remove a hallucinated requirement → delete it
```

After manual corrections, re-run `openlore verify` to confirm the spec
validates cleanly. **Only proceed to refactoring once the spec is trusted.**

---

## 4. Read the Mapping Artifact

`.openlore/analysis/mapping.json` structure:

```json
{
  "generatedAt": "...",
  "stats": {
    "totalRequirements": 24,
    "mappedRequirements": 19,
    "totalExportedFunctions": 87,
    "orphanCount": 31
  },
  "mappings": [
    {
      "requirement": "Extract entities",
      "service": "SpecGenerationPipeline",
      "domain": "generator",
      "specFile": "openspec/specs/generator/spec.md",
      "functions": [
        {
          "name": "runStage2",
          "file": "src/core/generator/spec-pipeline.ts",
          "line": 593,
          "kind": "function",
          "confidence": "llm"
        }
      ]
    }
  ],
  "orphanFunctions": [
    {
      "name": "oldHelperFn",
      "file": "src/utils/legacy.ts",
      "line": 12,
      "kind": "function",
      "confidence": "llm"
    }
  ]
}
```

**`confidence` field:**
- `"llm"` — the LLM identified this function directly from the source code
- `"heuristic"` — matched by name similarity (less reliable, verify manually)

---

## 4b. Re-analyze to Enrich Refactoring Priorities  *(no LLM required)*

After `generate` has produced `mapping.json`, re-run `analyze` to enrich the
refactoring report with **requirement mappings**:

```bash
openlore analyze
```

The updated `refactor-priorities.json` now includes a `requirements` field per
function — making it possible to detect **SRP violations** (functions that
implement too many requirements):

```json
{
  "function": "check_authentication",
  "file": "auth.py",
  "fanIn": 3,
  "fanOut": 15,
  "requirements": ["Authenticate User", "Validate Token", "Refresh Session"],
  "issues": ["high_fan_out", "multi_requirement"],
  "priorityScore": 7.5
}
```

The full report structure:

```json
{
  "generatedAt": "...",
  "stats": {
    "totalFunctions": 266,
    "withIssues": 7,
    "unreachable": 0,
    "highFanIn": 2,
    "highFanOut": 5,
    "srpViolations": 1,
    "cycleParticipants": 0,
    "cyclesDetected": 0
  },
  "priorities": [ ... ],   // sorted by priorityScore descending
  "cycles": [ ... ]        // each cycle: { sccId, size, participants[] }
}
```

**Using the report with an AI assistant:**

*Via CLI:*
```bash
# Extract top refactoring candidates with their requirements
cat .openlore/analysis/refactor-priorities.json | \
  jq '[.priorities[] | {function, file, issues, requirements, priorityScore}] | .[0:10]'
```

*Via MCP (Cline / Claude Code):* call `get_refactor_report({ directory: "..." })` — the AI receives the full report directly and can act on it without a copy-paste step.

Paste the output to an AI with instructions like:
```
These functions have structural issues identified by static analysis.
For each one, suggest how to split or simplify it:
[paste output]
```

---

## 5. Refactoring Actions

### 5a. Dead Code Detection

`orphanFunctions` lists all exported functions not referenced in any requirement.

These are candidates for deletion — but verify first:
- Is the function part of the public API (consumed externally)?
- Is it re-exported from an index file?
- Was it simply missed by the LLM in Stage 3?

Filter by confidence and kind:
```bash
# Quick look at orphans — function/class kinds only
cat .openlore/analysis/mapping.json | \
  jq '.orphanFunctions | map(select(.kind == "function" or .kind == "class"))'
```

### 5b. Naming Normalization

The spec uses canonical names derived from the business domain. Compare them
with actual function names in the mapping:

```bash
# Find mismatches between spec requirement name and function name
cat .openlore/analysis/mapping.json | \
  jq '.mappings[] | select(.functions | length > 0) | {req: .requirement, fn: .functions[0].name}'
```

If the spec says `"Build Repository Map"` and the function is `createRepoStuff`,
that's a renaming candidate.

### 5c. Domain Boundaries

The mapping shows which domain each function belongs to via `domain` and
`specFile`. Functions mapped to a domain but living in another domain's
directory signal misplaced code.

```bash
# Check for cross-domain misplacements
cat .openlore/analysis/mapping.json | \
  jq '.mappings[] | select(.functions | length > 0) | {domain: .domain, file: .functions[0].file}'
```

---

## 6. Iterative Refactoring Loop

```
openlore analyze          # re-analyze after changes (fast, no LLM)
openlore generate -y      # regenerate specs + mapping
```

After each refactoring batch:
1. Re-run `analyze` to update the dependency graph and call graph
2. Re-run `generate` to get a fresh mapping
3. Re-run `analyze` again to enrich the refactoring report with the new mapping
4. Check that `orphanCount` decreases and `mappedRequirements` increases
5. Check that `withIssues` in `refactor-priorities.json` decreases
6. Use `openlore drift` to verify specs still match the refactored code

---

## 7. AI-Assisted Refactoring

The specs, mapping, and refactoring report are designed to be used as context
for AI coding assistants (Claude, GPT-4, Cursor, etc.). The structured formats
are directly readable by any AI.

### 7a. MCP-native workflow (Cline / Claude Code)

With `openlore mcp` running, your AI agent can drive the entire analysis loop
without you running any CLI commands:

```
1. analyze_codebase({ directory: "/path/to/project" })
   → project overview, call graph stats, top-10 refactor issues

2. get_refactor_report({ directory: "..." })
   → full prioritized list with SRP violations and cycles

3. get_subgraph({ directory: "...", functionName: "check_authentication", direction: "both" })
   → who calls it, what it calls, blast radius of a split

4. get_signatures({ directory: "...", filePattern: "auth" })
   → public API of the auth module before touching it
```

The AI can iterate — call `get_refactor_report` again after it has made changes
to verify the priority score dropped — without leaving the editor.

### 7b. Prioritize with the refactoring report first

Before diving into domain-level refactoring, use `refactor-priorities.json` to
identify which files and functions need the most attention:

```bash
# Top 10 by priority score, with their issues and requirements
cat .openlore/analysis/refactor-priorities.json | \
  jq '[.priorities[:10][] | {function, file, fanIn, fanOut, issues, requirements, priorityScore}]'

# Only SRP violations (too many requirements)
cat .openlore/analysis/refactor-priorities.json | \
  jq '[.priorities[] | select(.issues | contains(["multi_requirement"]))]'

# Only cyclic dependencies
cat .openlore/analysis/refactor-priorities.json | \
  jq '.cycles'
```

### 8a. Refactor a domain with spec as context

Paste the domain spec and ask the AI to align the code to it:

```
Context: [paste openspec/specs/analyzer/spec.md]

The spec above is the ground truth for the "analyzer" domain.
Here are the files to refactor: [paste file contents or use @file references]

Tasks:
1. Rename functions to match the requirement names in the spec
2. Ensure each operation listed has a matching exported function
3. Do not change behavior, only naming and structure
```

### 8b. Dead code removal

Generate the list of orphans and ask the AI to delete them:

```bash
cat .openlore/analysis/mapping.json | \
  jq '[.orphanFunctions[] | select(.kind == "function" or .kind == "class") | {name, file}]'
```

Then:

```
These functions are not referenced in any spec requirement.
Review each one and delete it if it is not part of the public API:
[paste orphan list]
```

### 8c. Renaming pass with mapping as instructions

```bash
cat .openlore/analysis/mapping.json | \
  jq '[.mappings[] | select(.functions | length > 0) | {spec: .requirement, actual: .functions[0].name, file: .functions[0].file}] | map(select(.spec != .actual))'
```

Feed the output to the AI:

```
Rename the following functions to match their spec names.
Do not change signatures or behavior.
[paste mismatch list]
```

### 7c. Domain-scoped architecture enforcement

Use the architecture spec to prevent layer violations:

```
Context: [paste openspec/specs/architecture/spec.md]

The architecture above defines strict layer boundaries.
Review this file and flag any violations (e.g. presentation layer
calling infrastructure directly): [paste file content]
```

### Tips for AI-assisted refactoring

- **One domain at a time** — paste only the relevant domain spec, not all specs
- **Spec + mapping together** — the spec says *what*, the mapping says *where*;
  giving both lets the AI make precise targeted changes
- **Verify `confidence: "heuristic"` matches manually** before giving them to
  an AI — false positives will cause wrong renames
- **Use drift after each AI pass** — `openlore drift` confirms the refactored
  code still aligns with the specs

---

## 8. Test Generation from Spec

Each requirement's scenarios (GIVEN/WHEN/THEN) are ready-made test cases. Once
the refactoring has aligned the code with the spec, generate tests to lock in
the behavior before further changes.

### 8a. Generate tests with AI using spec as source

```
Context: [paste openspec/specs/analyzer/spec.md]

For each requirement and its scenarios, generate a unit test in Vitest.
Use the GIVEN/WHEN/THEN structure directly as the test body.
Map each requirement to a describe block, each scenario to an it() block.

Files under test: [paste file contents or use @file references]
```

The scenarios in the spec are behavioral descriptions — the AI can turn them
directly into `describe` / `it` blocks with mocked inputs and asserted outputs.

### 8b. Mapping → test file skeleton

Use the mapping to know exactly which functions need coverage:

```bash
# Functions with no heuristic matches = confirmed spec coverage
cat .openlore/analysis/mapping.json | \
  jq '[.mappings[] | select(.functions | length > 0 and (.functions[] | .confidence == "llm")) | {fn: .functions[0].name, file: .functions[0].file, scenario: .requirement}]'
```

Feed to AI:
```
Generate test stubs for each of the following functions.
Use the scenario name as the test description.
[paste output]
```

### 8c. Validate coverage completeness

After generating tests, cross-check against the orphan list — any orphan still
present after cleanup that has no test coverage is a double signal for deletion.

---

## 9. Drift Detection (ongoing)

Once the codebase is normalized, use drift detection to keep specs in sync:

```bash
openlore drift            # compares current code against specs
```

Reports files that changed after spec generation, grouped by domain, so you
know which specs need updating.

---

## Tips

- **Start with `orphanFunctions` of kind `function` or `class`** — these are
  the clearest dead code candidates.
- **Trust `confidence: "llm"` over `"heuristic"`** — heuristic matches are
  approximate and may need manual verification.
- **The spec is the ground truth for naming** — when a spec name and a function
  name diverge, prefer renaming the function to match the spec.
- **Domain specs are reusable as context** for AI coding assistants — paste
  `openspec/specs/{domain}/spec.md` as context when asking an AI to refactor
  that domain.
