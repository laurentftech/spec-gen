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

const SYSTEM_PROMPT = `You are an architectural decision verifier for a software project.

You receive:
1. A list of consolidated architectural decisions (with their IDs)
2. A git diff

Your task: for each decision, determine if the diff contains clear evidence that it was implemented.

Also identify significant changes in the diff that are NOT covered by any decision.

Respond with JSON only:
{
  "verified": [{ "id": string, "evidenceFile": string, "confidence": "high" | "medium" | "low" }],
  "phantom":  [{ "id": string }],
  "missing":  [{ "file": string, "description": string }]
}

Rules:
- "verified": the diff clearly shows this decision being implemented (look for matching patterns, types, function names, config keys)
- "phantom": the diff shows no sign this was implemented (may have been rolled back)
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

export async function verifyDecisions(
  decisions: PendingDecision[],
  diff: string,
  llm: LLMService,
): Promise<VerificationResult> {
  if (decisions.length === 0) {
    return { verified: [], phantom: [], missing: [] };
  }

  const decisionSummary = decisions.map((d) => ({
    id: d.id,
    title: d.title,
    affectedFiles: d.affectedFiles,
    proposedRequirement: d.proposedRequirement,
  }));

  const userContent = `Decisions:\n${JSON.stringify(decisionSummary, null, 2)}\n\nDiff:\n${diff.slice(0, 20_000)}`;

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
    .map((v) => {
      const d = byId.get(v.id);
      if (!d) return null;
      return { ...d, status: 'verified' as const, confidence: v.confidence, evidenceFile: v.evidenceFile, verifiedAt: now };
    })
    .filter((d): d is PendingDecision => d !== null);

  const phantom: PendingDecision[] = result.phantom
    .map((p) => {
      const d = byId.get(p.id);
      if (!d) return null;
      return { ...d, status: 'phantom' as const, confidence: 'low' as const, verifiedAt: now };
    })
    .filter((d): d is PendingDecision => d !== null);

  return { verified, phantom, missing: result.missing };
}

function parseJSON<T>(text: string, fallback: T): T {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return fallback;
  }
}
