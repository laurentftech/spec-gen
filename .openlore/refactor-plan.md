# Refactor Plan

Generated: 2026-04-20
Workflow: /openlore-plan-refactor → /openlore-execute-refactor

## Target
- **Function**: `validateDirectory`
- **File**: `src/core/services/mcp-handlers/utils.ts`
- **Lines**: 18–53
- **Risk score**: 100 (critical)
- **Strategy**: introduce façade
- **Priority score before refactor**: 5.5

## Why
- High fan-in (41 callers) making it a critical hub
- High risk score due to extensive upstream dependencies
- Central validation function used across multiple MCP handlers
- Current implementation is monolithic with multiple responsibilities

## Callers (upstream — must not break)
| Caller | File |
|---|---|
| handleAnalyzeCodebase | src/core/services/mcp-handlers/analysis.ts |
| handleGetArchitectureOverview | src/core/services/mcp-handlers/analysis.ts |
| handleGetRefactorReport | src/core/services/mcp-handlers/analysis.ts |
| handleGetDuplicateReport | src/core/services/mcp-handlers/analysis.ts |
| handleGetSignatures | src/core/services/mcp-handlers/analysis.ts |
| handleGetMapping | src/core/services/mcp-handlers/analysis.ts |
| handleCheckSpecDrift | src/core/services/mcp-handlers/analysis.ts |
| handleGetFunctionSkeleton | src/core/services/mcp-handlers/analysis.ts |
| handleGetFunctionBody | src/core/services/mcp-handlers/analysis.ts |
| handleGetDecisions | src/core/services/mcp-handlers/analysis.ts |
| handleGetRouteInventory | src/core/services/mcp-handlers/analysis.ts |
| handleGetMiddlewareInventory | src/core/services/mcp-handlers/analysis.ts |
| handleGetSchemaInventory | src/core/services/mcp-handlers/analysis.ts |
| handleGetUIComponents | src/core/services/mcp-handlers/analysis.ts |
| handleGetEnvVars | src/core/services/mcp-handlers/analysis.ts |
| handleAuditSpecCoverage | src/core/services/mcp-handlers/analysis.ts |
| handleGenerateTests | src/core/services/mcp-handlers/analysis.ts |
| handleGetTestCoverage | src/core/services/mcp-handlers/analysis.ts |
| handleOrient | src/core/services/mcp-handlers/orient.ts |
| handleGetCallGraph | src/core/services/mcp-handlers/graph.ts |
| handleGetSubgraph | src/core/services/mcp-handlers/graph.ts |
| handleAnalyzeImpact | src/core/services/mcp-handlers/graph.ts |
| handleGetLowRiskRefactorCandidates | src/core/services/mcp-handlers/graph.ts |
| handleGetLeafFunctions | src/core/services/mcp-handlers/graph.ts |
| handleGetCriticalHubs | src/core/services/mcp-handlers/graph.ts |
| handleGetGodFunctions | src/core/services/mcp-handlers/graph.ts |
| handleGetFileDependencies | src/core/services/mcp-handlers/graph.ts |
| handleTraceExecutionPath | src/core/services/mcp-handlers/graph.ts |
| handleSearchCode | src/core/services/mcp-handlers/semantic.ts |
| handleSuggestInsertionPoints | src/core/services/mcp-handlers/semantic.ts |
| handleGetSpec | src/core/services/mcp-handlers/semantic.ts |
| handleListSpecDomains | src/core/services/mcp-handlers/semantic.ts |
| handleSearchSpecs | src/core/services/mcp-handlers/semantic.ts |
| handleUnifiedSearch | src/core/services/mcp-handlers/semantic.ts |
| handleGenerateChangeProposal | src/core/services/mcp-handlers/change.ts |
| handleAnnotateStory | src/core/services/mcp-handlers/change.ts |
| handleRecordDecision | src/core/services/mcp-handlers/decisions.ts |
| handleListDecisions | src/core/services/mcp-handlers/decisions.ts |
| handleApproveDecision | src/core/services/mcp-handlers/decisions.ts |
| handleRejectDecision | src/core/services/mcp-handlers/decisions.ts |
| handleSyncDecisions | src/core/services/mcp-handlers/decisions.ts |
| startMcpServer | src/cli/commands/mcp.ts |
| execute | src/core/services/chat-tools.ts |

## Callees (downstream — candidates for extraction)
| Callee | File |
|---|---|
| calculateDirectoryDepth | src/core/services/mcp-handlers/utils.ts |

## Coverage baseline
- **File**: `src/core/services/mcp-handlers/utils.ts`
- **Coverage**: Unknown (no test coverage data available)
- **Status**: 🚫 (no tests found)
- **Test command**: `npm test -- src/core/services/mcp-handlers/utils.ts`

## Change sequence
Each change is a complete mini-development: edit → diff → test → ✅ or rollback.
Never advance to the next change without a green test gate.

### Change 1 — Extract directory depth validation
- **What**: Extract lines 32–38 (directory depth validation logic)
- **Lines touched in source**: ~7 lines (must be ≤ 50)
- **New function name**: `validateDirectoryDepth`
- **Target file**: `src/core/services/mcp-handlers/utils.ts` (same file - internal extraction)
- **Target class**: none
- **Call sites to update**: `validateDirectoryImpl` (line 33)
- **Expected diff**: +7 lines in same file, -7 lines in same file
- **Test gate**: `npm test -- src/core/services/mcp-handlers/utils.ts`
- **Retry limit**: 3 attempts — if still red after 3, stop and report

### Change 2 — Extract directory existence validation
- **What**: Extract lines 40–50 (directory existence and type validation)
- **Lines touched in source**: ~11 lines (must be ≤ 50)
- **New function name**: `validateDirectoryExists`
- **Target file**: `src/core/services/mcp-handlers/utils.ts` (same file - internal extraction)
- **Target class**: none
- **Call sites to update**: `validateDirectoryImpl` (lines 42, 47)
- **Expected diff**: +11 lines in same file, -11 lines in same file
- **Test gate**: `npm test -- src/core/services/mcp-handlers/utils.ts`
- **Retry limit**: 3 attempts — if still red after 3, stop and report

### Change 3 — Create validation façade
- **What**: Create new `validateDirectory` façade that delegates to extracted functions
- **Lines touched in source**: ~15 lines (must be ≤ 50)
- **New function name**: `validateDirectory` (keep same name)
- **Target file**: `src/core/services/mcp-handlers/utils.ts` (same file)
- **Target class**: none
- **Call sites to update**: None (public API remains unchanged)
- **Expected diff**: +15 lines in same file
- **Test gate**: `npm test -- src/core/services/mcp-handlers/utils.ts`
- **Retry limit**: 3 attempts — if still red after 3, stop and report

### Change 4 — Update callers to use façade
- **What**: Update all 41 callers to call the new façade (no functional change)
- **Lines touched in source**: ~41 call sites across multiple files
- **New function name**: `validateDirectory` (unchanged)
- **Target file**: Multiple files (all callers)
- **Target class**: none
- **Call sites to update**: All 41 callers listed above
- **Expected diff**: 0 lines added, 0 lines removed (refactoring only)
- **Test gate**: `npm test` (full test suite)
- **Retry limit**: 3 attempts — if still red after 3, stop and report

## Acceptance criteria
- Priority score drops below 3.0 in `get_refactor_report`
- Function exits the top-5 list
- Full test suite passes (green)
- `git diff --stat` shows only the expected files

## Restore point
Hash: 2f177f8