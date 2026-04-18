/**
 * Decision extractor — fallback path
 *
 * When an agent hasn't called record_decision during development,
 * this module extracts architectural decisions directly from the git diff.
 * Produces decisions at status 'consolidated' (lower confidence than
 * manually recorded drafts, but immediately ready for verification).
 */

import {
  DECISIONS_EXTRACTION_MAX_FILES,
  DECISIONS_DIFF_MAX_CHARS,
  DECISIONS_CONSOLIDATION_MAX_TOKENS,
} from '../../constants.js';
import { getChangedFiles, getFileDiff, resolveBaseRef } from '../drift/git-diff.js';
import { matchFileToDomains, getSpecContent } from '../drift/spec-mapper.js';
import { isSpecRelevantChange } from '../drift/drift-detector.js';
import type { LLMService } from '../services/llm-service.js';
import type { PendingDecision, SpecMap } from '../../types/index.js';
import { makeDecisionId } from './store.js';
import { parseJSON } from '../../utils/misc.js';

const SYSTEM_PROMPT = `You are an architectural decision extractor for a software project.

You receive git diffs for source files belonging to one spec domain, along with the existing requirements for that domain.

Your task: identify architectural decisions embedded in these changes — choices about structure, technology, contracts, or behavior that a future developer should understand.

Rules:
- Only surface decisions with architectural significance (not style fixes, typo patches, comment changes, test updates)
- A single diff may yield 0, 1, or 2 decisions
- For trivial changes return []
- proposedRequirement: one sentence in imperative form ("The system SHALL …"), or null

Respond with a JSON array only. Each element:
{
  "title": string,
  "rationale": string,
  "consequences": string,
  "affectedFiles": string[],
  "proposedRequirement": string | null
}`;

interface ExtractedRaw {
  title: string;
  rationale: string;
  consequences: string;
  affectedFiles: string[];
  proposedRequirement: string | null;
}

export interface ExtractFromDiffOptions {
  rootPath: string;
  baseRef?: string;
  specMap: SpecMap;
  sessionId: string;
  llm: LLMService;
}

/**
 * Extract architectural decisions from the current git diff.
 * Used as fallback when the agent produced no record_decision drafts.
 * Returns decisions at status 'consolidated', ready for verification.
 */
export async function extractFromDiff(options: ExtractFromDiffOptions): Promise<PendingDecision[]> {
  const { rootPath, specMap, sessionId, llm } = options;

  // Default to HEAD (staged changes only) — 'auto' would compare the full branch vs main.
  const baseRef = await resolveBaseRef(rootPath, options.baseRef ?? 'HEAD');
  const gitResult = await getChangedFiles({ rootPath, baseRef, includeUnstaged: false });

  const relevant = gitResult.files
    .filter((f) => isSpecRelevantChange(f))
    .slice(0, DECISIONS_EXTRACTION_MAX_FILES);

  if (relevant.length === 0) return [];

  // Group files by domain for coherent LLM calls
  const byDomain = new Map<string, typeof relevant>();
  for (const file of relevant) {
    const domains = matchFileToDomains(file.path, specMap);
    const key = domains[0] ?? 'unknown';
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key)!.push(file);
  }

  const results: PendingDecision[] = [];
  const now = new Date().toISOString();

  for (const [domain, files] of byDomain) {
    // Get diffs
    const diffs = await Promise.all(
      files.map((f) => getFileDiff(rootPath, f.path, baseRef, DECISIONS_DIFF_MAX_CHARS))
    );

    // Get existing spec requirements for context
    const specExcerpt = await getSpecContent(domain, specMap, rootPath, 2_000) ?? '';
    const requirementsExcerpt = extractRequirements(specExcerpt);

    const userContent = [
      `Domain: ${domain}`,
      requirementsExcerpt ? `Existing requirements (excerpt):\n${requirementsExcerpt}` : '',
      '',
      ...files.map((f, i) => `=== ${f.path} ===\n${diffs[i]}`),
    ].filter(Boolean).join('\n\n');

    const response = await llm.complete({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: userContent,
      maxTokens: DECISIONS_CONSOLIDATION_MAX_TOKENS,
      temperature: 0.1,
    });

    const extracted = parseJSON<ExtractedRaw[]>(response.content, []);

    for (const e of extracted) {
      const id = makeDecisionId(sessionId, domain, e.title);
      results.push({
        id,
        status: 'consolidated',
        title: e.title,
        rationale: e.rationale,
        consequences: e.consequences,
        proposedRequirement: e.proposedRequirement,
        affectedDomains: [domain],
        affectedFiles: e.affectedFiles.length ? e.affectedFiles : files.map((f) => f.path),
        sessionId,
        recordedAt: now,
        consolidatedAt: now,
        confidence: 'medium',
        syncedToSpecs: [],
      });
    }
  }

  return results;
}

function extractRequirements(specContent: string): string {
  const lines = specContent.split('\n');
  const reqLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('### Requirement:') || (reqLines.length > 0 && line.startsWith('  '))) {
      reqLines.push(line);
      if (reqLines.length > 30) break;
    }
  }
  return reqLines.join('\n');
}
