# openlore: Write Tests

Write real tests for a function or spec scenario — language-agnostic (TypeScript, Python, C++…).
Reads the implementation and spec contract first, runs tests, fixes failures.

**No stubs. No placeholder assertions. No `expect(true).toBe(true)`.**

Steps 1–3 are read-only. No test is written before Step 4.

---

## Step 1: Get the project directory and target

<ask_followup_question>
  <question>What would you like to test?</question>
  <options>[
    "A specific function or file (I'll provide the name)",
    "Find untested spec scenarios automatically",
    "All untested scenarios in a domain"
  ]</options>
</ask_followup_question>

Ask for `$PROJECT_ROOT` if not already known.

**If "Find untested scenarios" or "All untested in a domain":**

<use_mcp_tool>
  <server_name>openlore</server_name>
  <tool_name>get_test_coverage</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>

Present the top 5 uncovered scenarios to the user. Ask which to implement first. Store the
chosen scenario as `$TARGET`.

**Detect the test framework** by scanning for config files:

| File | Framework | Runner |
|---|---|---|
| `vitest.config.*` | Vitest | `npx vitest run <file>` |
| `jest.config.*` | Jest | `npx jest <file>` |
| `pytest.ini`, `pyproject.toml` (`[tool.pytest]`) | pytest | `pytest <file> -v` |
| `CMakeLists.txt` with `enable_testing()` | CTest/GTest | build + `ctest` |
| `go.mod` | Go test | `go test ./...` |

Store as `$TEST_RUNNER`.

---

## Step 2: Orient

<use_mcp_tool>
  <server_name>openlore</server_name>
  <tool_name>orient</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "task": "write tests for $TARGET",
    "limit": 5
  }</arguments>
</use_mcp_tool>

From the result, note:
- `$TARGET_FILE` — file containing the function(s) to test
- `$EXISTING_TEST_FILE` — nearby test file if any (`foo.test.ts`, `test_foo.py`, `foo_test.go`)
- `$SPEC_DOMAIN` — the spec domain associated with the target

---

## Step 3: Read implementation + spec contract

**Do not write any test before completing this step.**

### 3a — Read the function body

<use_mcp_tool>
  <server_name>openlore</server_name>
  <tool_name>get_function_body</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "symbol": "$TARGET_FUNCTION",
    "filePath": "$TARGET_FILE"
  }</arguments>
</use_mcp_tool>

Identify: inputs, return value, external dependencies to mock, invariants (guards, throws, early returns).

### 3b — Find the spec contract

If `openspec/specs/` exists:

<use_mcp_tool>
  <server_name>openlore</server_name>
  <tool_name>search_specs</tool_name>
  <arguments>{
    "directory": "$PROJECT_ROOT",
    "query": "$TARGET — expected behaviour",
    "limit": 5
  }</arguments>
</use_mcp_tool>

For each matching spec scenario, note the **GIVEN / WHEN / THEN** clauses — these become the
test body. The scenario name becomes the test description (`it()` / `def test_` / `TEST()`).

If no specs exist, infer the contract from the function signature, docstring, and call sites.
Document the inferred contract in a comment before the first test.

### 3c — Absorb local test conventions

Read `$EXISTING_TEST_FILE` if it exists (or the closest test file in the project tree). Extract:
- Mock setup pattern (`vi.mock`, `unittest.mock.patch`, `gmock`, etc.)
- Fixture or factory helpers already defined
- Import path style and suite structure

---

## Step 4: Write tests

Write (or append to) `$EXISTING_TEST_FILE`. Create it next to the source file if it doesn't exist
(`<name>.test.ts` / `test_<name>.py` / `<name>_test.go`).

### Mandatory rules

- **No placeholder assertions** — every assertion must test a real return value or side effect
- **One test = one scenario** — `it()` / `def test_` description = spec scenario name or contract statement
- **Annotation tag** — place immediately above each `describe` / class / suite block:
  - TS/JS: `// openlore: {"domain":"$DOMAIN","requirement":"$REQ","scenario":"$SCENARIO","specFile":"openspec/specs/$DOMAIN/spec.md"}`
  - Python: `# openlore: {"domain":"$DOMAIN","requirement":"$REQ","scenario":"$SCENARIO"}`
  - C++/Go: `// openlore: {"domain":"$DOMAIN","requirement":"$REQ","scenario":"$SCENARIO"}`
  - Omit if no spec scenario exists (contract inferred from implementation)
- **Mock only system boundaries** — filesystem, network, LLM API, DB, external process. Not pure helpers
- **One suite per function** — `describe` / class / suite named after the function
- **At least one edge case** per function — empty input, null, max value, or error path

---

## Step 5: Run and fix

Run:

```
$TEST_RUNNER $TEST_FILE_PATH
```

Repeat until all tests pass.

| Outcome | Action |
|---|---|
| All green | Proceed to Step 6 |
| Failure in new test | Fix assertion if expectation was wrong. If a real bug is revealed, report it — do not weaken the assertion |
| Failure in pre-existing test | Fix the regression before adding more tests |
| Compile / import error | Fix mock setup or import path before retrying |

---

## Step 6: Coverage report

<use_mcp_tool>
  <server_name>openlore</server_name>
  <tool_name>get_test_coverage</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT"}</arguments>
</use_mcp_tool>

Report:
- Spec scenarios now covered (new)
- Remaining uncovered scenarios in `$SPEC_DOMAIN`
- High-value next targets (hub functions still untested)

---

## Absolute constraints

- Never write `expect(true).toBe(true)`, `assert True`, or equivalent placeholder assertions
- Never skip Step 3 — implementation read and spec contract are the test source of truth
- Never mock the function under test itself
- Never weaken an assertion to make a test pass — fix the implementation or the expectation
- If `get_test_coverage` shows the scenario is already covered, report it and stop
- Do not refactor the implementation as part of this workflow — open a separate task
