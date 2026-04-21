/**
 * Decision verifier
 *
 * Cross-checks consolidated decisions against the actual git diff to:
 *  - "verified"  — decision has clear code evidence
 *  - "phantom"   — recorded but no matching change found in diff
 *  - "missing"   — significant diff change not covered by any decision
 */

import { DECISIONS_VERIFICATION_MAX_TOKENS } from '../../constants.js';
import type { LLMService } from '../services/llm-service.js';
import type { PendingDecision } from '../../types/index.js';
import { parseJSON } from '../../utils/misc.js';

const SYSTEM_PROMPT = `You are an architectural decision verifier for a software project.

You receive a list of architectural decisions. Each decision includes a "targetedDiff" field containing the git diff hunks for its affected files (or a sample of the overall diff if no specific files matched). You may also receive commit messages for context.

Your task: for each decision, determine if its targetedDiff contains clear evidence that it was implemented. Also identify significant changes not covered by any decision.

Respond with JSON only:
{
  "verified": [{ "id": string, "evidenceFile": string, "confidence": "high" | "medium" | "low" }],
  "phantom":  [{ "id": string }],
  "missing":  [{ "file": string, "description": string }]
}

Rules:
- "verified": the diff clearly shows this decision being implemented (matching patterns, types, function names, config keys, commit messages)
- "phantom": no sign of implementation in the diff (may have been rolled back or not yet committed)
- "missing": a structurally significant change (new interface, new function, dependency added, API change) that no decision covers
- Only report "missing" for architectural-level changes, not trivial ones`;

interface VerificationRaw {
  verified: Array<{ id: string; evidenceFile: string; confidence: 'high' | 'medium' | 'low' }>;
  phantom: Array<{ id: string }>;
  missing: Array<{ file: string; description: string }>;
}

export interface VerificationResult {
  verified: PendingDecision[];
  phantom: PendingDecision[];
  missing: Array<{ file: string; description: string }>;
}

/** Maximum chars to include per file hunk in targeted diff */
const FILE_HUNK_LIMIT = 4_000;
/** Maximum total diff chars passed to LLM across all targeted hunks */
const TARGETED_DIFF_LIMIT = 16_000;

/**
 * Parse a combined git diff into a map of { filePath → hunk text }.
 * File paths are normalised to strip the leading a/ or b/ prefix.
 */
function parseDiffByFile(diff: string): Map<string, string> {
  const result = new Map<string, string>();
  const sections = diff.split(/^(?=diff --git )/m);
  for (const section of sections) {
    if (!section.trim()) continue;
    const header = section.match(/^diff --git a\/(.+?) b\//);
    if (!header) continue;
    const file = header[1];
    result.set(file, section.length > FILE_HUNK_LIMIT ? section.slice(0, FILE_HUNK_LIMIT) + '\n... (truncated)' : section);
  }
  return result;
}

/**
 * Build a targeted diff string for a single decision.
 * Includes only hunks for files listed in affectedFiles.
 * Falls back to a slice of the full diff if no files match.
 */
function buildTargetedDiff(
  decision: PendingDecision,
  diffByFile: Map<string, string>,
  fallbackDiff: string,
): string {
  const parts: string[] = [];
  let total = 0;
  for (const file of decision.affectedFiles) {
    const normalised = file.replace(/^[ab]\//, '');
    const hunk = diffByFile.get(normalised);
    if (!hunk) continue;
    const chunk = hunk.length > FILE_HUNK_LIMIT ? hunk.slice(0, FILE_HUNK_LIMIT) + '\n... (truncated)' : hunk;
    if (total + chunk.length > TARGETED_DIFF_LIMIT) break;
    parts.push(chunk);
    total += chunk.length;
  }
  if (parts.length > 0) return parts.join('\n');
  // No matching files — pass a slice of the global diff so the LLM can still check
  return fallbackDiff.slice(0, 4_000);
}

export async function verifyDecisions(
  decisions: PendingDecision[],
  diff: string,
  llm: LLMService,
  commitMessages?: string,
): Promise<VerificationResult> {
  if (decisions.length === 0) {
    return { verified: [], phantom: [], missing: [] };
  }

  const diffByFile = parseDiffByFile(diff);

  const decisionSummary = decisions.map((d) => ({
    id: d.id,
    title: d.title,
    affectedFiles: d.affectedFiles,
    proposedRequirement: d.proposedRequirement,
    targetedDiff: buildTargetedDiff(d, diffByFile, diff),
  }));

  const commitSection = commitMessages ? `\nCommit messages:\n${commitMessages}\n` : '';
  const userContent = `Decisions:\n${JSON.stringify(decisionSummary, null, 2)}${commitSection}`;

  const response = await llm.complete({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userContent,
    maxTokens: DECISIONS_VERIFICATION_MAX_TOKENS,
    temperature: 0.1,
  });
  const raw = response.content;

  const result = parseJSON<VerificationRaw>(raw, { verified: [], phantom: [], missing: [] });

  const byId = new Map(decisions.map((d) => [d.id, d]));
  const now = new Date().toISOString();

  const verified: PendingDecision[] = result.verified
    .flatMap((v) => {
      const d = byId.get(v.id);
      if (!d) return [];
      return [{ ...d, status: 'verified' as const, confidence: v.confidence, evidenceFile: v.evidenceFile, verifiedAt: now }];
    });

  const phantom: PendingDecision[] = result.phantom
    .flatMap((p) => {
      const d = byId.get(p.id);
      if (!d) return [];
      return [{ ...d, status: 'phantom' as const, confidence: 'low' as const, verifiedAt: now }];
    });

  return { verified, phantom, missing: result.missing };
}
