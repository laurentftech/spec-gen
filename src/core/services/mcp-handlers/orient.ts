/**
 * `orient` — composite orientation tool.
 *
 * Given a natural-language task description, returns in ONE call:
 *  - Relevant functions (semantic search or BM25 fallback)
 *  - Unique source files involved
 *  - Spec domains that cover those files
 *  - Depth-1 call neighbourhood for each top function
 *  - Top insertion point candidates
 *  - Matching spec sections (if spec index is available)
 *
 * Designed as the single entry point agents use at the start of any task,
 * replacing the need to chain analyze_codebase → search_code → search_specs
 * → suggest_insertion_points manually.
 */

import { join } from 'node:path';
import { validateDirectory, loadMappingIndex, specsForFile, readCachedContext } from './utils.js';
import { readSpecGenConfig } from '../config-manager.js';
import {
  classifyRole,
  deriveStrategy,
  compositeScore,
  buildReason,
} from './semantic.js';

// ============================================================================
// TYPES
// ============================================================================

interface OrientFunction {
  name: string;
  filePath: string;
  score: number;
  signature?: string;
  docstring?: string;
  language: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
  isEntryPoint: boolean;
  linkedSpecs: Array<{ requirement: string; domain: string; specFile: string }>;
}

interface CallNeighbour {
  name: string;
  filePath: string;
}

interface OrientCallPath {
  function: string;
  filePath: string;
  callers: CallNeighbour[];
  callees: CallNeighbour[];
}

interface OrientInsertionPoint {
  rank: number;
  name: string;
  filePath: string;
  role: string;
  strategy: string;
  reason: string;
  score: number;
}

interface OrientSpecMatch {
  domain: string;
  section: string;
  title: string;
  score: number;
  text: string;
}

// ============================================================================
// HANDLER
// ============================================================================

export async function handleOrient(
  directory: string,
  task: string,
  limit = 5,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, '.spec-gen', 'analysis');

  const { VectorIndex } = await import('../../analyzer/vector-index.js');
  const { EmbeddingService } = await import('../../analyzer/embedding-service.js');
  const { SpecVectorIndex } = await import('../../analyzer/spec-vector-index.js');

  const hasCodeIndex = VectorIndex.exists(outputDir);
  const hasSpecIndex = SpecVectorIndex.exists(outputDir);

  if (!hasCodeIndex) {
    return {
      error: 'No analysis found. Run "spec-gen analyze --embed" first.',
      hint: 'With BM25 fallback, "spec-gen analyze" alone (no --embed) is also sufficient.',
    };
  }

  // Resolve embedding service — null triggers BM25 fallback in VectorIndex.search()
  let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
  let searchMode = 'hybrid';
  try {
    embedSvc = EmbeddingService.fromEnv();
  } catch {
    const cfg = await readSpecGenConfig(absDir);
    const svcFromConfig = cfg ? EmbeddingService.fromConfig(cfg) : null;
    if (svcFromConfig) {
      embedSvc = svcFromConfig;
    } else {
      searchMode = 'bm25_fallback';
    }
  }

  const clampedLimit = Math.max(1, Math.min(limit, 20));

  // ── Parallel data loading ──────────────────────────────────────────────────
  const [rawResults, mappingIdx, llmCtx] = await Promise.all([
    VectorIndex.search(outputDir, task, embedSvc, { limit: clampedLimit * 3 }),
    loadMappingIndex(absDir),
    readCachedContext(absDir),
  ]);

  // ── Build call graph adjacency maps ───────────────────────────────────────
  const callerMap = new Map<string, CallNeighbour[]>();
  const calleeMap = new Map<string, CallNeighbour[]>();

  if (llmCtx?.callGraph) {
    const cg = llmCtx.callGraph;
    const nodeById = new Map(cg.nodes.map(n => [n.id, n]));
    for (const n of cg.nodes) {
      callerMap.set(n.id, []);
      calleeMap.set(n.id, []);
    }
    for (const e of cg.edges) {
      if (!e.calleeId) continue;
      const caller = nodeById.get(e.callerId);
      const callee = nodeById.get(e.calleeId);
      if (caller && callee) {
        calleeMap.get(e.callerId)?.push({ name: callee.name, filePath: callee.filePath });
        callerMap.get(e.calleeId)?.push({ name: caller.name, filePath: caller.filePath });
      }
    }
  }

  // ── Relevant functions (top-N) ────────────────────────────────────────────
  const topResults = rawResults.slice(0, clampedLimit);

  const relevantFunctions: OrientFunction[] = topResults.map(r => ({
    name: r.record.name,
    filePath: r.record.filePath,
    score: parseFloat((1 - r.score).toFixed(3)),
    signature: r.record.signature || undefined,
    docstring: r.record.docstring || undefined,
    language: r.record.language,
    fanIn: r.record.fanIn,
    fanOut: r.record.fanOut,
    isHub: r.record.isHub,
    isEntryPoint: r.record.isEntryPoint,
    linkedSpecs: mappingIdx ? specsForFile(mappingIdx, r.record.filePath) : [],
  }));

  // ── Relevant files (deduplicated) ─────────────────────────────────────────
  const relevantFiles = [...new Set(relevantFunctions.map(f => f.filePath))];

  // ── Spec domains covering those files ─────────────────────────────────────
  const domainScores = new Map<string, { specFile: string; matchCount: number }>();
  if (mappingIdx) {
    for (const filePath of relevantFiles) {
      const specs = specsForFile(mappingIdx, filePath);
      for (const s of specs) {
        const prev = domainScores.get(s.domain) ?? { specFile: s.specFile, matchCount: 0 };
        domainScores.set(s.domain, { ...prev, matchCount: prev.matchCount + 1 });
      }
    }
  }
  const specDomains = [...domainScores.entries()]
    .sort((a, b) => b[1].matchCount - a[1].matchCount)
    .slice(0, 5)
    .map(([domain, { specFile, matchCount }]) => ({ domain, specFile, matchCount }));

  // ── Call paths for each top function ──────────────────────────────────────
  const callPaths: OrientCallPath[] = topResults.map(r => ({
    function: r.record.name,
    filePath: r.record.filePath,
    callers: (callerMap.get(r.record.id) ?? []).slice(0, 5),
    callees: (calleeMap.get(r.record.id) ?? []).slice(0, 5),
  }));

  // ── Insertion points (lightweight: reuse rawResults with structural scoring) ──
  const insertionCandidates = rawResults.map(r => {
    const role     = classifyRole(r.record.fanIn, r.record.fanOut, r.record.isHub, r.record.isEntryPoint);
    const strategy = deriveStrategy(role);
    const score    = compositeScore(r.score, role);
    return {
      name: r.record.name,
      filePath: r.record.filePath,
      role, strategy, score,
      reason: buildReason(r.record.name, role, strategy, r.record.fanIn, r.record.fanOut),
    };
  });
  insertionCandidates.sort((a, b) => b.score - a.score);
  const insertionPoints: OrientInsertionPoint[] = insertionCandidates
    .slice(0, 3)
    .map((c, i) => ({ rank: i + 1, ...c, score: parseFloat(c.score.toFixed(3)) }));

  // ── Spec search (best-effort — skipped if spec index not available) ────────
  let matchingSpecs: OrientSpecMatch[] | undefined;
  if (hasSpecIndex && embedSvc) {
    try {
      const specResults = await SpecVectorIndex.search(outputDir, task, embedSvc, { limit: 3 });
      matchingSpecs = specResults.map(r => ({
        domain: r.record.domain,
        section: r.record.section,
        title: r.record.title,
        score: parseFloat((1 - r.score).toFixed(3)),
        text: r.record.text.slice(0, 300) + (r.record.text.length > 300 ? '…' : ''),
      }));
    } catch {
      // non-fatal — spec index may be corrupt or unavailable
    }
  }

  // ── Next steps ────────────────────────────────────────────────────────────
  const nextSteps: string[] = [];
  if (insertionPoints.length > 0) {
    nextSteps.push(
      `Call get_subgraph("${insertionPoints[0].name}") to trace the call neighbourhood`,
    );
  }
  if (specDomains.length > 0) {
    nextSteps.push(
      `Call get_spec("${specDomains[0].domain}") to read the full spec before writing code`,
    );
  }
  nextSteps.push('After implementing, run check_spec_drift to verify the code matches the spec');

  return {
    task,
    searchMode,
    ...(searchMode === 'bm25_fallback'
      ? { note: 'Embedding server unavailable — results use keyword matching. Run "spec-gen analyze --embed" for semantic search.' }
      : {}),
    relevantFiles,
    relevantFunctions,
    specDomains,
    callPaths,
    insertionPoints,
    ...(matchingSpecs !== undefined ? { matchingSpecs } : {}),
    nextSteps,
  };
}
