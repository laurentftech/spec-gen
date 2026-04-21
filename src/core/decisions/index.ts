/**
 * Decisions module — agent-recorded architectural decisions
 *
 * Workflow:
 *   1. Agent calls record_decision() (MCP) during dev → draft stored in pending.json
 *   2. At commit: consolidateDrafts() merges/resolves contradictions via LLM
 *   3. verifyDecisions() cross-checks consolidated set against git diff
 *   4. Human/agent approves via CLI or MCP
 *   5. syncApprovedDecisions() writes to spec.md + creates ADRs
 */

export { loadDecisionStore, saveDecisionStore, upsertDecisions, patchDecision, getDecisionsByStatus, makeDecisionId, newSessionId, decisionsDir } from './store.js';
export { consolidateDrafts } from './consolidator.js';
export { extractFromDiff } from './extractor.js';
export type { ExtractFromDiffOptions } from './extractor.js';
export { verifyDecisions } from './verifier.js';
export type { VerificationResult } from './verifier.js';
export { syncApprovedDecisions } from './syncer.js';
export type { SyncOptions, SyncResult } from './syncer.js';
