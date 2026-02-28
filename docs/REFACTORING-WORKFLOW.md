# Refactoring Workflow with spec-gen

Workflow for using spec-gen to refactor an existing codebase — particularly
useful for vibe-coded projects with inconsistent naming, dead code, and poor
normalization.

---

## 1. Initial Setup

```bash
cd your-project
spec-gen init        # detects project type, creates .spec-gen/config.json
spec-gen analyze     # static analysis — no LLM, builds dependency graph
```

**Outputs:**
- `.spec-gen/config.json` — configuration
- `.spec-gen/analysis/repo-structure.json` — file significance scores, domain detection
- `.spec-gen/analysis/dependency-graph.json` — exports, imports, connectivity per file

---

## 2. Generate the Spec

```bash
spec-gen generate -y
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
- `.spec-gen/analysis/mapping.json` — **requirement → function mapping** (see below)

---

## 3. Validate the Generated Spec

**Before refactoring**, the spec must be reviewed and corrected. An LLM can
misclassify domains, invent requirements, or miss critical operations. Starting
a refactoring from a bad spec will normalize the code toward the wrong target.

### 3a. Automated validation

```bash
spec-gen verify       # validates specs against source code
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

After manual corrections, re-run `spec-gen verify` to confirm the spec
validates cleanly. **Only proceed to refactoring once the spec is trusted.**

---

## 4. Read the Mapping Artifact

`.spec-gen/analysis/mapping.json` structure:

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

## 4. Refactoring Actions

### 4a. Dead Code Detection

`orphanFunctions` lists all exported functions not referenced in any requirement.

These are candidates for deletion — but verify first:
- Is the function part of the public API (consumed externally)?
- Is it re-exported from an index file?
- Was it simply missed by the LLM in Stage 3?

Filter by confidence and kind:
```bash
# Quick look at orphans — function/class kinds only
cat .spec-gen/analysis/mapping.json | \
  jq '.orphanFunctions | map(select(.kind == "function" or .kind == "class"))'
```

### 4b. Naming Normalization

The spec uses canonical names derived from the business domain. Compare them
with actual function names in the mapping:

```bash
# Find mismatches between spec requirement name and function name
cat .spec-gen/analysis/mapping.json | \
  jq '.mappings[] | select(.functions | length > 0) | {req: .requirement, fn: .functions[0].name}'
```

If the spec says `"Build Repository Map"` and the function is `createRepoStuff`,
that's a renaming candidate.

### 4c. Domain Boundaries

The mapping shows which domain each function belongs to via `domain` and
`specFile`. Functions mapped to a domain but living in another domain's
directory signal misplaced code.

```bash
# Check for cross-domain misplacements
cat .spec-gen/analysis/mapping.json | \
  jq '.mappings[] | select(.functions | length > 0) | {domain: .domain, file: .functions[0].file}'
```

---

## 5. Iterative Refactoring Loop

```
spec-gen analyze          # re-analyze after changes (fast, no LLM)
spec-gen generate -y      # regenerate specs + mapping
```

After each refactoring batch:
1. Re-run `analyze` to update the dependency graph
2. Re-run `generate` to get a fresh mapping
3. Check that `orphanCount` decreases and `mappedRequirements` increases
4. Use `spec-gen drift` to verify specs still match the refactored code

---

## 6. AI-Assisted Refactoring

The specs and mapping artifact are designed to be used as context for AI
coding assistants (Claude, GPT-4, Cursor, etc.). The structured Markdown
format is directly readable by any AI.

### 6a. Refactor a domain with spec as context

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

### 6b. Dead code removal

Generate the list of orphans and ask the AI to delete them:

```bash
cat .spec-gen/analysis/mapping.json | \
  jq '[.orphanFunctions[] | select(.kind == "function" or .kind == "class") | {name, file}]'
```

Then:

```
These functions are not referenced in any spec requirement.
Review each one and delete it if it is not part of the public API:
[paste orphan list]
```

### 6c. Renaming pass with mapping as instructions

```bash
cat .spec-gen/analysis/mapping.json | \
  jq '[.mappings[] | select(.functions | length > 0) | {spec: .requirement, actual: .functions[0].name, file: .functions[0].file}] | map(select(.spec != .actual))'
```

Feed the output to the AI:

```
Rename the following functions to match their spec names.
Do not change signatures or behavior.
[paste mismatch list]
```

### 6d. Domain-scoped architecture enforcement

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
- **Use drift after each AI pass** — `spec-gen drift` confirms the refactored
  code still aligns with the specs

---

## 7. Test Generation from Spec

Each requirement's scenarios (GIVEN/WHEN/THEN) are ready-made test cases. Once
the refactoring has aligned the code with the spec, generate tests to lock in
the behavior before further changes.

### 7a. Generate tests with AI using spec as source

```
Context: [paste openspec/specs/analyzer/spec.md]

For each requirement and its scenarios, generate a unit test in Vitest.
Use the GIVEN/WHEN/THEN structure directly as the test body.
Map each requirement to a describe block, each scenario to an it() block.

Files under test: [paste file contents or use @file references]
```

The scenarios in the spec are behavioral descriptions — the AI can turn them
directly into `describe` / `it` blocks with mocked inputs and asserted outputs.

### 7b. Mapping → test file skeleton

Use the mapping to know exactly which functions need coverage:

```bash
# Functions with no heuristic matches = confirmed spec coverage
cat .spec-gen/analysis/mapping.json | \
  jq '[.mappings[] | select(.functions | length > 0 and (.functions[] | .confidence == "llm")) | {fn: .functions[0].name, file: .functions[0].file, scenario: .requirement}]'
```

Feed to AI:
```
Generate test stubs for each of the following functions.
Use the scenario name as the test description.
[paste output]
```

### 7c. Validate coverage completeness

After generating tests, cross-check against the orphan list — any orphan still
present after cleanup that has no test coverage is a double signal for deletion.

---

## 8. Drift Detection (ongoing)

Once the codebase is normalized, use drift detection to keep specs in sync:

```bash
spec-gen drift            # compares current code against specs
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
