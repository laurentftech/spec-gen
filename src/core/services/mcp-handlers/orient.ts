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
import { readFile, stat } from 'node:fs/promises';
import { validateDirectory, loadMappingIndex, specsForFile, functionsForDomain, readCachedContext } from './utils.js';
import { readSpecGenConfig } from '../config-manager.js';
import type { RagManifest } from '../../generator/rag-manifest-generator.js';
import { OPENSPEC_DIR, ARTIFACT_RAG_MANIFEST } from '../../../constants.js';
import {
  classifyRole,
  deriveStrategy,
  compositeScore,
  buildReason,
} from './semantic.js';

// ============================================================================
// MANIFEST CACHE
// ============================================================================

interface CondensedEntry {
  content: string;
  mtime: number;
}

interface ManifestCache {
  manifest: RagManifest;
  /** mtimeMs of rag-manifest.json at load time */
  fileMtime: number;
  /** condensed spec content keyed by specPath, each with its own mtime */
  condensed: Map<string, CondensedEntry>;
}

/** One cache entry per project directory (MCP server is long-lived). */
const _manifestCache = new Map<string, ManifestCache>();

/** Load (or return cached) RagManifest. Returns undefined on any error. */
async function loadManifestCached(manifestPath: string, cacheKey: string): Promise<ManifestCache | undefined> {
  try {
    const mtime = (await stat(manifestPath)).mtimeMs;
    const cached = _manifestCache.get(cacheKey);
    if (cached && cached.fileMtime === mtime) return cached;
    const raw = await readFile(manifestPath, 'utf-8');
    const entry: ManifestCache = {
      manifest: JSON.parse(raw) as RagManifest,
      fileMtime: mtime,
      condensed: cached?.condensed ?? new Map(),
    };
    _manifestCache.set(cacheKey, entry);
    return entry;
  } catch {
    return undefined;
  }
}

/** Load (or return cached) condensed spec content for a single spec file. */
async function loadCondensedCached(cache: ManifestCache, absSpecPath: string, specPath: string): Promise<string | undefined> {
  try {
    const mtime = (await stat(absSpecPath)).mtimeMs;
    const cached = cache.condensed.get(specPath);
    if (cached && cached.mtime === mtime) return cached.content;
    const raw = await readFile(absSpecPath, 'utf-8');
    const content = condenseSpec(raw);
    cache.condensed.set(specPath, { content, mtime });
    return content;
  } catch {
    return undefined;
  }
}

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

interface InlineSpec {
  domain: string;
  specPath: string;
  sourceFiles: string[];
  dependsOn: string[];
  calledBy: string[];
  /** Condensed spec content: Purpose + Dependencies section + Requirement names with file:line */
  content: string;
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
    score: parseFloat(r.score.toFixed(3)),
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

  // ── RIG-20: cross-graph spec traversal — seed → spec domains → peer functions ──
  // Surfaces implementations linked via the spec even when the call graph
  // doesn't connect them to the seed functions.
  type SpecLinkedFunction = { name: string; filePath: string; domain: string; requirement: string };
  const specLinkedFunctions: SpecLinkedFunction[] = [];
  if (mappingIdx && relevantFunctions.length > 0) {
    const seedDomains = new Set<string>();
    for (const fn of relevantFunctions) {
      for (const spec of fn.linkedSpecs) seedDomains.add(spec.domain);
    }
    const seedFileSet = new Set(relevantFiles);
    const seen = new Set<string>();
    for (const domain of seedDomains) {
      for (const fn of functionsForDomain(mappingIdx, domain)) {
        const key = `${fn.name}::${fn.file}`;
        if (seen.has(key) || seedFileSet.has(fn.file)) continue;
        seen.add(key);
        specLinkedFunctions.push({ name: fn.name, filePath: fn.file, domain, requirement: fn.requirement });
      }
    }
  }

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
  // Normalise search scores to [0, 1] for compositeScore (scores are RRF/BM25: higher = better)
  const maxRawScore = rawResults.length > 0 ? Math.max(...rawResults.map(r => r.score)) : 1;
  const normalise = (s: number) => maxRawScore > 0 ? s / maxRawScore : 0;

  const insertionCandidates = rawResults.map(r => {
    const role     = classifyRole(r.record.fanIn, r.record.fanOut, r.record.isHub, r.record.isEntryPoint);
    const strategy = deriveStrategy(role);
    const score    = compositeScore(normalise(r.score), role);
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
        score: parseFloat(r.score.toFixed(3)),
        text: r.record.text.slice(0, 300) + (r.record.text.length > 300 ? '…' : ''),
      }));
    } catch {
      // non-fatal — spec index may be corrupt or unavailable
    }
  }

  // ── Inline spec purpose from RAG manifest ─────────────────────────────────
  let inlineSpecs: InlineSpec[] | undefined;
  if (specDomains.length > 0) {
    try {
      const cfg = await readSpecGenConfig(absDir);
      const openspecRelPath = cfg?.openspecPath ?? OPENSPEC_DIR;
      const manifestPath = join(absDir, openspecRelPath, ARTIFACT_RAG_MANIFEST);
      const manifestCache = await loadManifestCached(manifestPath, absDir);
      if (manifestCache) {
        const { manifest } = manifestCache;
        const specs = await Promise.all(
          specDomains.slice(0, 3).map(async sd => {
            const entry = manifest.domains.find(d => d.domain.toLowerCase() === sd.domain.toLowerCase());
            if (!entry) return null;
            const absSpecPath = join(absDir, entry.specPath);
            const content = await loadCondensedCached(manifestCache, absSpecPath, entry.specPath);
            if (!content) return null;
            const MAX_SOURCE_FILES = 8;
            const relFiles = entry.sourceFiles.map(f =>
              f.startsWith(absDir) ? f.slice(absDir.length).replace(/^\//, '') : f,
            );
            const sourceFiles = relFiles.length > MAX_SOURCE_FILES
              ? [...relFiles.slice(0, MAX_SOURCE_FILES), `… and ${relFiles.length - MAX_SOURCE_FILES} more`]
              : relFiles;
            return {
              domain: sd.domain,
              specPath: entry.specPath,
              sourceFiles,
              dependsOn: entry.dependsOn,
              calledBy: entry.calledBy,
              content,
            } satisfies InlineSpec;
          }),
        );
        const filtered = specs.filter((s): s is InlineSpec => s !== null);
        if (filtered.length > 0) inlineSpecs = filtered;
      }
    } catch {
      // non-fatal — manifest may not exist yet (generate not yet run)
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
    const hint = inlineSpecs
      ? `Domain purposes included in inlineSpecs — call get_spec("${specDomains[0].domain}") for requirements and implementation details`
      : `Call get_spec("${specDomains[0].domain}") to read the full spec before writing code`;
    nextSteps.push(hint);
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
    ...(specLinkedFunctions.length > 0 ? { specLinkedFunctions } : {}),
    specDomains,
    ...(inlineSpecs !== undefined ? { inlineSpecs } : {}),
    callPaths,
    insertionPoints,
    ...(matchingSpecs !== undefined ? { matchingSpecs } : {}),
    nextSteps,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Condense a spec to its ## Purpose paragraph only (~50-150 chars).
 * dependsOn/calledBy are already in the InlineSpec manifest fields.
 * Full requirements are available via get_spec.
 */
function condenseSpec(content: string): string {
  const lines = content.split('\n');
  const purposeStart = lines.findIndex(l => /^## Purpose\s*$/.test(l));
  if (purposeStart === -1) return '';
  let i = purposeStart + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const out: string[] = [];
  while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#')) {
    out.push(lines[i++]);
  }
  return out.join('\n').trim().replace(/^\[PARTIAL SPEC[^\]]*\]\s*/i, '');
}
