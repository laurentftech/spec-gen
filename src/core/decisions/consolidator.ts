/**
 * Decision consolidator
 *
 * Calls LLM to merge/resolve draft decisions from a session into a clean set.
 * Resolves contradictions and collapses superseded decisions.
 */

import {
  DECISIONS_CONSOLIDATION_MAX_TOKENS,
} from '../../constants.js';
import type { LLMService } from '../services/llm-service.js';
import type { PendingDecision, DecisionStore } from '../../types/index.js';
import { makeDecisionId } from './store.js';

const SYSTEM_PROMPT = `You are an architectural decision consolidator for a software project.

You receive a list of architectural decision drafts recorded by an AI agent during a coding session. Some decisions may contradict each other or be superseded by later decisions. Your task is to produce a clean, consolidated set representing the final architectural state after the session.

Rules:
- Keep only decisions that represent the FINAL state (most recent wins for contradictions)
- If a decision has a "supersedes" field, mark the referenced decision as resolved
- Merge related decisions about the same topic into one when they are complementary
- Typically produce 1-3 consolidated decisions; never more than 5
- Preserve the original rationale and consequences from the drafts
- proposedRequirement should be a single sentence in imperative form, or null

Respond with a JSON array only. Each element:
{
  "title": string,
  "rationale": string,
  "consequences": string,
  "affectedDomains": string[],
  "affectedFiles": string[],
  "proposedRequirement": string | null,
  "supersededIds": string[]
}

If there are no meaningful architectural decisions, return [].`;

interface ConsolidatedRaw {
  title: string;
  rationale: string;
  consequences: string;
  affectedDomains: string[];
  affectedFiles: string[];
  proposedRequirement: string | null;
  supersededIds: string[];
}

export async function consolidateDrafts(
  store: DecisionStore,
  llm: LLMService,
): Promise<PendingDecision[]> {
  const drafts = store.decisions.filter((d) => d.status === 'draft');
  if (drafts.length === 0) return [];

  const userContent = JSON.stringify(
    drafts.map((d) => ({
      id: d.id,
      title: d.title,
      rationale: d.rationale,
      consequences: d.consequences,
      affectedDomains: d.affectedDomains,
      affectedFiles: d.affectedFiles,
      supersedes: d.supersedes,
      recordedAt: d.recordedAt,
    })),
    null,
    2,
  );

  const response = await llm.complete({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userContent,
    maxTokens: DECISIONS_CONSOLIDATION_MAX_TOKENS,
    temperature: 0.1,
  });
  const raw = response.content;

  const consolidated = parseJSON<ConsolidatedRaw[]>(raw, []);
  const now = new Date().toISOString();

  return consolidated.map((c): PendingDecision => {
    const domain = c.affectedDomains[0] ?? 'unknown';
    return {
      id: makeDecisionId(store.sessionId, domain, c.title),
      status: 'consolidated',
      title: c.title,
      rationale: c.rationale,
      consequences: c.consequences,
      proposedRequirement: c.proposedRequirement,
      affectedDomains: c.affectedDomains,
      affectedFiles: c.affectedFiles,
      confidence: 'medium',
      sessionId: store.sessionId,
      recordedAt: now,
      consolidatedAt: now,
      syncedToSpecs: [],
    };
  });
}

function parseJSON<T>(text: string, fallback: T): T {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return fallback;
  }
}
