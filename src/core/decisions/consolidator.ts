/**
 * Decision consolidator
 *
 * Calls LLM to merge/resolve draft decisions from a session into a clean set.
 * Resolves contradictions and collapses superseded decisions.
 */

import {
  DECISIONS_CONSOLIDATION_MAX_TOKENS,
} from '../../constants.js';
import { logger } from '../../utils/logger.js';
import type { LLMService } from '../services/llm-service.js';
import type { PendingDecision, DecisionStore, SpecMap } from '../../types/index.js';
import { makeDecisionId } from './store.js';
import { parseJSON } from '../../utils/misc.js';
import { matchFileToDomains } from '../drift/spec-mapper.js';

const SYSTEM_PROMPT = `You are an architectural decision consolidator for a software project.

You receive a list of architectural decision drafts recorded by an AI agent during a coding session. Some decisions may contradict each other or be superseded by later decisions. Your task is to produce a clean, consolidated set representing the final architectural state after the session.

Rules:
- Keep only decisions that represent the FINAL state (most recent wins for contradictions)
- If a decision has a "supersedes" field, mark the referenced decision as resolved
- Merge related decisions about the same topic into one when they are complementary
- Typically produce 1-3 consolidated decisions; never more than 5
- Preserve the original rationale and consequences from the drafts
- proposedRequirement should be a single sentence starting with "The system SHALL", or null

Keep a decision if it describes ANY of:
- A new feature, command, flag, or capability added to the system
- A change to where responsibility lives (which module/command owns what)
- A choice between two viable approaches (even if the choice seems obvious in hindsight)
- A behaviour that would surprise a future developer reading the code
- A constraint or limitation deliberately introduced

Only discard decisions that are ALL of:
- Pure refactors with no behaviour change (rename, extract helper, fix types)
- AND already obvious from the surrounding code without explanation
- AND recorded no rationale beyond "follow existing patterns"

Good examples: "Move hook installation from decisions to setup command", "Use system prompt injection instead of tool-output blocking for completion guard", "Prefer local dist/cli/index.js over global spec-gen in pre-commit hook"
Bad examples: "Use TypeScript interfaces for type safety", "Add error handling", "Follow existing service pattern"

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

If there are genuinely no decisions worth keeping, return [].`;

interface ConsolidatedRaw {
  title: string;
  rationale: string;
  consequences: string;
  affectedDomains: string[];
  affectedFiles: string[];
  proposedRequirement: string | null;
  supersededIds: string[];
}

export interface ConsolidateResult {
  decisions: PendingDecision[];
  supersededIds: string[];
}

export async function consolidateDrafts(
  store: DecisionStore,
  llm: LLMService,
  specMap?: SpecMap,
): Promise<ConsolidateResult> {
  const drafts = store.decisions.filter((d) => d.status === 'draft');
  if (drafts.length === 0) return { decisions: [], supersededIds: [] };

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

  if (consolidated.length === 0 && drafts.length > 0) {
    logger.warning(`consolidation returned 0 decisions from ${drafts.length} drafts — LLM response: ${raw.slice(0, 300)}`);
  }

  const now = new Date().toISOString();
  const allSupersededIds = consolidated.flatMap((c) => c.supersededIds ?? []);

  const decisions = consolidated.map((c): PendingDecision => {
    // Remap LLM-produced domain names to spec-map ground truth using affectedFiles.
    // Falls back to LLM names if specMap is absent or files yield no match.
    const resolvedDomains = resolveDomainsFromFiles(c.affectedFiles, c.affectedDomains, specMap);
    const domain = resolvedDomains[0] ?? 'unknown';
    return {
      id: makeDecisionId(store.sessionId, domain, c.title),
      status: 'consolidated',
      title: c.title,
      rationale: c.rationale,
      consequences: c.consequences,
      proposedRequirement: c.proposedRequirement,
      affectedDomains: resolvedDomains,
      affectedFiles: c.affectedFiles,
      confidence: 'medium',
      sessionId: store.sessionId,
      recordedAt: now,
      consolidatedAt: now,
      syncedToSpecs: [],
    };
  });

  return { decisions, supersededIds: allSupersededIds };
}

/**
 * Remap LLM-produced domain names to spec-map ground truth.
 * Uses affectedFiles as the anchor: if files can be matched to known spec domains,
 * those names take precedence over whatever the LLM suggested.
 */
function resolveDomainsFromFiles(
  files: string[],
  llmDomains: string[],
  specMap?: SpecMap,
): string[] {
  if (!specMap || files.length === 0) return llmDomains.length > 0 ? llmDomains : ['unknown'];

  const matched = new Set<string>();
  for (const file of files) {
    for (const domain of matchFileToDomains(file, specMap)) {
      matched.add(domain);
    }
  }

  if (matched.size > 0) return [...matched];

  // Files didn't match — try normalising LLM names against known domains
  const knownDomains = [...specMap.byDomain.keys()];
  const normalised = llmDomains
    .map((d) => knownDomains.find((k) => k.toLowerCase() === d.toLowerCase()) ?? null)
    .filter((d): d is string => d !== null);

  return normalised.length > 0 ? normalised : llmDomains.length > 0 ? llmDomains : ['unknown'];
}
