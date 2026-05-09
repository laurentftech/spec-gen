/**
 * MCP tool handlers for call-graph analysis:
 * get_call_graph, get_subgraph, analyze_impact, get_critical_hubs,
 * get_leaf_functions, get_low_risk_refactor_candidates, get_god_functions,
 * trace_execution_path.
 */

import { validateDirectory, readCachedContext } from './utils.js';
import type { CachedContext } from './utils.js';
import { join } from 'node:path';
import {
  RISK_SCORE_FAN_IN_WEIGHT,
  RISK_SCORE_FAN_OUT_WEIGHT,
  RISK_SCORE_HUB_BONUS,
  RISK_SCORE_BLAST_RADIUS_WEIGHT,
  RISK_SCORE_LOW_THRESHOLD,
  RISK_SCORE_MEDIUM_THRESHOLD,
  GOD_FUNCTION_FAN_OUT_THRESHOLD,
  REFACTOR_SRP_FAN_OUT_THRESHOLD,
  LOW_RISK_MAX_FAN_IN,
  LOW_RISK_MAX_FAN_OUT,
  CRITICAL_HUBS_DEFAULT_MIN_FAN_IN,
  SUBGRAPH_DEFAULT_MAX_DEPTH,
  SUBGRAPH_MAX_DEPTH_LIMIT,
  CRITICALITY_FAN_IN_WEIGHT,
  CRITICALITY_FAN_OUT_WEIGHT,
  CRITICALITY_VIOLATION_BONUS,
  STABILITY_SCORE_CAN_REFACTOR,
  STABILITY_SCORE_STABILISE_FIRST,
  LOW_RISK_REFACTOR_CANDIDATES_DEFAULT_LIMIT,
  LEAF_FUNCTIONS_DEFAULT_LIMIT,
  HUB_HIGH_FAN_IN_THRESHOLD,
  HUB_HIGH_FAN_OUT_THRESHOLD,
  SPEC_GEN_DIR,
  SPEC_GEN_ANALYSIS_SUBDIR,
  TRACE_PATH_DEFAULT_MAX_DEPTH,
  TRACE_PATH_MAX_PATHS,
} from '../../../constants.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';
import { getFileGodFunctions, extractSubgraph } from '../../analyzer/subgraph-extractor.js';
import { readSpecGenConfig } from '../config-manager.js';

// ============================================================================
// SHARED GRAPH HELPERS (also exported for chat-tools.ts)
// ============================================================================

/**
 * Build forward (caller→callees) and backward (callee→callers) adjacency maps
 * from a serialised call graph, returning both maps and a node lookup.
 *
 * Includes inheritance edges: parent class methods point forward to all child
 * class methods so blast-radius BFS propagates through the class hierarchy.
 */
export function buildAdjacency(cg: SerializedCallGraph) {
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const forward  = new Map<string, Set<string>>(); // callerId → Set<calleeId>
  const backward = new Map<string, Set<string>>(); // calleeId → Set<callerId>

  for (const n of cg.nodes) {
    forward.set(n.id, new Set());
    backward.set(n.id, new Set());
  }
  for (const e of cg.edges) {
    if (!e.calleeId) continue;
    // Ensure external nodes (not in cg.nodes) get adjacency entries
    if (!forward.has(e.calleeId))  forward.set(e.calleeId,  new Set());
    if (!backward.has(e.calleeId)) backward.set(e.calleeId, new Set());
    forward.get(e.callerId)?.add(e.calleeId);
    backward.get(e.calleeId)?.add(e.callerId);
  }

  // Expand class-level inheritance: parent method → child method
  // (changing a parent propagates blast radius to all child class methods)
  const classMap = new Map((cg.classes ?? []).map(c => [c.id, c]));
  for (const ie of (cg.inheritanceEdges ?? [])) {
    const parentClass = classMap.get(ie.parentId);
    const childClass  = classMap.get(ie.childId);
    if (!parentClass || !childClass) continue;
    // Guard against N×M explosion on large classes
    if (parentClass.methodIds.length * childClass.methodIds.length > 200) continue;
    for (const parentMethodId of parentClass.methodIds) {
      if (!forward.has(parentMethodId)) forward.set(parentMethodId, new Set());
      for (const childMethodId of childClass.methodIds) {
        if (!backward.has(childMethodId)) backward.set(childMethodId, new Set());
        forward.get(parentMethodId)!.add(childMethodId);
        backward.get(childMethodId)!.add(parentMethodId);
      }
    }
  }

  return { nodeMap, forward, backward };
}

/** BFS up to `maxDepth`. Returns a map of visited node-id → depth reached. */
export function bfs(
  seeds: string[],
  adjacency: Map<string, Set<string>>,
  maxDepth: number
): Map<string, number> {
  const visited = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = seeds.map(id => ({ id, depth: 0 }));
  for (const id of seeds) visited.set(id, 0);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    for (const nId of adjacency.get(id) ?? []) {
      if (!visited.has(nId)) {
        visited.set(nId, depth + 1);
        queue.push({ id: nId, depth: depth + 1 });
      }
    }
  }
  return visited;
}

/**
 * DB-backed lazy BFS — fetches only edges for visited nodes instead of loading all edges.
 * direction: 'forward' = downstream (callees), 'backward' = upstream (callers).
 */
export function bfsFromDB(
  seeds: string[],
  direction: 'forward' | 'backward',
  maxDepth: number,
  es: CachedContext['edgeStore']
): Map<string, number> {
  const visited = new Map<string, number>();
  for (const id of seeds) visited.set(id, 0);

  // Level-by-level BFS: one batch query per depth level, O(maxDepth) SQL queries.
  // Recursive CTE was tested but regressed backward BFS on high fan-in hubs (19ms→30ms):
  // SQLite UNION deduplicates on (id,depth) pairs, so (X,1) and (X,2) are both kept,
  // causing path explosion. Iterative frontier never re-visits a node.
  let frontier = seeds.filter(id => !id.startsWith('external::'));

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const edges = direction === 'forward'
      ? es!.getCalleesForIds(frontier)
      : es!.getCallersForIds(frontier);

    const nextFrontier: string[] = [];
    for (const e of edges) {
      const nId = direction === 'forward' ? e.calleeId : e.callerId;
      if (!visited.has(nId) && !nId.startsWith('external::')) {
        visited.set(nId, depth + 1);
        nextFrontier.push(nId);
      }
    }
    frontier = nextFrontier;
  }
  return visited;
}

/**
 * Compute a risk score [0–100] for a node.
 *
 * Weights: fan-in × 4, fan-out × 2, isHub × 20, blastRadius × 1.5. Capped at 100.
 */
export function computeRiskScore(node: FunctionNode, blastRadius: number, isHub: boolean): number {
  const raw =
    (node.fanIn  ?? 0) * RISK_SCORE_FAN_IN_WEIGHT +
    (node.fanOut ?? 0) * RISK_SCORE_FAN_OUT_WEIGHT +
    (isHub ? RISK_SCORE_HUB_BONUS : 0) +
    blastRadius * RISK_SCORE_BLAST_RADIUS_WEIGHT;
  return Math.min(100, Math.round(raw));
}

/** Derive a plain-language refactoring strategy from the risk profile. */
export function recommendStrategy(
  riskScore: number,
  fanIn: number,
  fanOut: number,
  isHub: boolean
): { approach: string; rationale: string } {
  if (riskScore <= RISK_SCORE_LOW_THRESHOLD) {
    return {
      approach: 'refactor freely',
      rationale:
        'Low fan-in and fan-out. Safe to rename, extract, or rewrite inline. ' +
        'A single PR with unit tests is sufficient.',
    };
  }
  if (riskScore <= RISK_SCORE_MEDIUM_THRESHOLD) {
    return {
      approach: 'refactor with tests',
      rationale:
        'Moderate caller count. Write characterisation tests before changing the signature. ' +
        'Prefer additive changes (new overload / wrapper) then migrate callers.',
    };
  }
  if (isHub && fanOut > REFACTOR_SRP_FAN_OUT_THRESHOLD) {
    return {
      approach: 'split responsibility (SRP)',
      rationale:
        'God-function: high fan-in AND high fan-out. Extract cohesive sub-responsibilities ' +
        'into smaller functions behind a thin façade. Migrate callers incrementally.',
    };
  }
  if (isHub) {
    return {
      approach: 'introduce façade',
      rationale:
        'Critical hub with many callers. Do not change the public signature. ' +
        'Introduce a façade or adapter layer, move logic behind it, ' +
        'then update callers in waves.',
    };
  }
  if (fanOut > GOD_FUNCTION_FAN_OUT_THRESHOLD) {
    return {
      approach: 'decompose fan-out',
      rationale:
        'Too many outgoing dependencies. Extract orchestration logic into smaller coordinators. ' +
        'Consider dependency injection to decouple from concrete callees.',
    };
  }
  return {
    approach: 'incremental extraction',
    rationale:
      'High risk due to caller count. Use the Strangler-Fig pattern: introduce a parallel ' +
      'implementation, migrate callers one by one, then delete the original.',
  };
}

export function nodeToSummary(n: FunctionNode | undefined) {
  if (!n) return { name: '', file: '', className: null, depth: 0 };
  return { name: n.name, file: n.filePath, className: n.className ?? null, depth: 0 };
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Return the call graph summary from cached analysis.
 */
export async function handleGetCallGraph(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };

  const cg = ctx.callGraph;
  return {
    stats: cg.stats,
    hubFunctions: cg.hubFunctions.map(n => ({
      name: n.name, file: n.filePath, className: n.className,
      fanIn: n.fanIn, fanOut: n.fanOut, language: n.language,
    })),
    entryPoints: cg.entryPoints.map(n => ({
      name: n.name, file: n.filePath, className: n.className, language: n.language,
    })),
    layerViolations: cg.layerViolations,
  };
}

/**
 * Extract a depth-limited subgraph centred on a named function.
 * Falls back to semantic search if no exact name match is found.
 */
export async function handleGetSubgraph(
  directory: string,
  functionName: string,
  direction: 'downstream' | 'upstream' | 'both' = 'downstream',
  maxDepth = SUBGRAPH_DEFAULT_MAX_DEPTH,
  format: 'json' | 'mermaid' = 'json'
): Promise<unknown> {
  maxDepth = Math.max(1, Math.min(maxDepth, SUBGRAPH_MAX_DEPTH_LIMIT));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.edgeStore) return { error: 'Call graph DB not available. Re-run analyze_codebase.' };

  const lower = functionName.toLowerCase();
  let seeds = ctx.edgeStore.searchNodes(lower);

  // Semantic search fallback when no name match
  if (seeds.length === 0) {
    try {
      const { VectorIndex } = await import('../../analyzer/vector-index.js');
      const { EmbeddingService } = await import('../../analyzer/embedding-service.js');
      const outputDir = join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);

      if (VectorIndex.exists(outputDir)) {
        let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
        try { embedSvc = EmbeddingService.fromEnv(); } catch {
          const cfg = await readSpecGenConfig(absDir);
          if (cfg?.embedding) embedSvc = EmbeddingService.fromConfig(cfg) ?? null;
        }
        if (embedSvc) {
          const results = await VectorIndex.search(outputDir, functionName, embedSvc, { limit: 1 });
          if (results.length > 0) {
            const matched = ctx.edgeStore.getNode(results[0].record.id);
            if (matched) seeds = [matched];
          }
        }
      }
    } catch { /* ignore fallback errors */ }
  }

  if (seeds.length === 0) return { error: `No function matching "${functionName}" found in call graph.` };

  const seedIds = seeds.map(s => s.id);
  const fwdVisited = (direction === 'downstream' || direction === 'both')
    ? bfsFromDB(seedIds, 'forward',  maxDepth, ctx.edgeStore)
    : new Map<string, number>();
  const bwdVisited = (direction === 'upstream' || direction === 'both')
    ? bfsFromDB(seedIds, 'backward', maxDepth, ctx.edgeStore)
    : new Map<string, number>();
  const visitedIds = new Set([...fwdVisited.keys(), ...bwdVisited.keys()]);

  const resolveNode = (id: string) => ctx.edgeStore!.getNode(id);

  const visibleNodes = Array.from(visitedIds)
    .map(id => resolveNode(id)!)
    .filter(Boolean)
    // stdlib nodes (Array.isArray, t.slice, …) are noise — exclude unless they are a seed
    .filter(n => !n.isExternal || n.externalKind !== 'stdlib' || seeds.some(s => s.id === n.id));

  const subNodes = visibleNodes.map(n => ({
    name: n.isExternal ? `[external] ${n.name}` : n.name,
    file: n.filePath,
    className: n.className,
    fanIn: n.fanIn, fanOut: n.fanOut, language: n.language,
    isExternal: n.isExternal ?? false,
    externalKind: n.externalKind,
    isSeed: seeds.some(s => s.id === n.id),
  }));

  const subEdges = Array.from(visitedIds).flatMap(id =>
    ctx.edgeStore!.getCallees(id)
      .filter(e => e.calleeId && visitedIds.has(e.calleeId))
      .map(e => {
        const callerN = resolveNode(e.callerId);
        const calleeN = resolveNode(e.calleeId);
        return {
          caller: callerN?.name ?? e.callerId,
          callee: calleeN?.isExternal ? `[external] ${calleeN.name}` : (calleeN?.name ?? e.calleeId),
          callerFile: callerN?.filePath,
          calleeFile: calleeN?.filePath,
          kind: e.kind ?? 'calls',
          callType: e.callType,
        };
      })
  );

  if (format === 'mermaid') {
    const idOf = new Map<string, string>();
    subNodes.forEach((n, i) => idOf.set(n.name + '|' + n.file, `n${i}`));
    const nodeLines = subNodes.map(n => {
      const id = idOf.get(n.name + '|' + n.file)!;
      const label = `"${n.name}\\n${n.file}"`;
      return n.isSeed ? `    ${id}[${label}]:::seed` : `    ${id}[${label}]`;
    });
    const edgeLines = subEdges.map(e => {
      const fromId = idOf.get(e.caller + '|' + e.callerFile) ?? e.caller;
      const toId   = idOf.get(e.callee + '|' + e.calleeFile) ?? e.callee;
      return `    ${fromId} --> ${toId}`;
    });
    const deduped = [...new Set(edgeLines)];
    const diagram = [
      'flowchart LR',
      '    classDef seed fill:#f5a623,stroke:#d4891a,color:#000',
      ...nodeLines, ...deduped,
    ].join('\n');
    return `\`\`\`mermaid\n${diagram}\n\`\`\`\n\n` +
      `_${subNodes.length} nodes · ${deduped.length} edges · seeds: ${seeds.map(s => s.name).join(', ')}_`;
  }

  return {
    query: { functionName, direction, maxDepth },
    seeds: seeds.map(n => ({ name: n.name, file: n.filePath })),
    stats: { nodes: subNodes.length, edges: subEdges.length },
    nodes: subNodes,
    edges: subEdges,
  };
}

/**
 * Deep impact analysis for a single symbol.
 * Falls back to semantic search if no exact name match is found.
 */
export async function handleAnalyzeImpact(
  directory: string,
  symbol: string,
  depth = 2
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)            return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.edgeStore)  return { error: 'Call graph DB not available. Re-run analyze_codebase.' };

  const lower = symbol.toLowerCase();
  let seeds = ctx.edgeStore.searchNodes(lower);

  // Semantic search fallback when no name match
  if (seeds.length === 0) {
    try {
      const { VectorIndex } = await import('../../analyzer/vector-index.js');
      const { EmbeddingService } = await import('../../analyzer/embedding-service.js');
      const outputDir = join(absDir, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR);

      if (VectorIndex.exists(outputDir)) {
        let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
        try { embedSvc = EmbeddingService.fromEnv(); } catch {
          const cfg = await readSpecGenConfig(absDir);
          if (cfg?.embedding) embedSvc = EmbeddingService.fromConfig(cfg) ?? null;
        }
        if (embedSvc) {
          const results = await VectorIndex.search(outputDir, symbol, embedSvc, { limit: 1 });
          if (results.length > 0) {
            const matched = ctx.edgeStore.getNode(results[0].record.id);
            if (matched) seeds = [matched];
          }
        }
      }
    } catch { /* ignore fallback errors */ }
  }

  if (seeds.length === 0) return { error: `No function matching "${symbol}" found in call graph.` };

  const seedIds     = seeds.map(n => n.id);
  const hubIds      = new Set(ctx.edgeStore.getHubs(500).map(n => n.id));
  const upstreamMap   = bfsFromDB(seedIds, 'backward', depth, ctx.edgeStore);
  const downstreamMap = bfsFromDB(seedIds, 'forward',  depth, ctx.edgeStore);

  const resolveNode = (id: string): FunctionNode | undefined =>
    ctx.edgeStore!.getNode(id) ?? undefined;

  const upstreamNodes = [...upstreamMap.entries()]
    .filter(([id]) => !seedIds.includes(id))
    .map(([id, d]) => ({ ...nodeToSummary(resolveNode(id)), depth: d }))
    .filter(n => n.name);

  const downstreamNodes = [...downstreamMap.entries()]
    .filter(([id]) => !seedIds.includes(id))
    .map(([id, d]) => ({ ...nodeToSummary(resolveNode(id)), depth: d }))
    .filter(n => n.name);

  const blastRadius = upstreamNodes.length + downstreamNodes.length;

  const results = seeds.map(seed => {
    const isHub     = hubIds.has(seed.id);
    const riskScore = computeRiskScore(seed, blastRadius, isHub);
    const strategy  = recommendStrategy(riskScore, seed.fanIn ?? 0, seed.fanOut ?? 0, isHub);
    const criticalPathLeaves = downstreamNodes.filter(n => n.depth === depth).map(n => n.name);

    return {
      symbol:    seed.name,
      file:      seed.filePath,
      className: seed.className ?? null,
      language:  seed.language,
      metrics:   { fanIn: seed.fanIn ?? 0, fanOut: seed.fanOut ?? 0, isHub },
      blastRadius: { total: blastRadius, upstream: upstreamNodes.length, downstream: downstreamNodes.length },
      riskScore,
      riskLevel: riskScore <= 20 ? 'low' : riskScore <= 45 ? 'medium' : riskScore <= 70 ? 'high' : 'critical',
      upstreamChain:          upstreamNodes,
      downstreamCriticalPath: downstreamNodes,
      criticalPathLeaves,
      recommendedStrategy: strategy,
    };
  });

  return seeds.length === 1 ? results[0] : { matches: results };
}

/**
 * Return the N safest functions to refactor.
 */
export async function handleGetLowRiskRefactorCandidates(
  directory: string,
  limit = LOW_RISK_REFACTOR_CANDIDATES_DEFAULT_LIMIT,
  filePattern?: string
): Promise<unknown> {
  limit = Math.max(1, Math.min(limit, 500));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg       = ctx.callGraph as SerializedCallGraph;
  const hubIds   = new Set(cg.hubFunctions.map(n => n.id));
  const entryIds = new Set(cg.entryPoints.map(n => n.id));

  let candidates = cg.nodes.filter(n => {
    const fanIn  = n.fanIn  ?? 0;
    const fanOut = n.fanOut ?? 0;
    return fanIn <= LOW_RISK_MAX_FAN_IN && fanOut <= LOW_RISK_MAX_FAN_OUT && !hubIds.has(n.id) && !entryIds.has(n.id);
  });

  if (filePattern) candidates = candidates.filter(n => n.filePath.includes(filePattern));

  candidates.sort((a, b) => {
    const ra = (a.fanIn ?? 0) + (a.fanOut ?? 0);
    const rb = (b.fanIn ?? 0) + (b.fanOut ?? 0);
    return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
  });

  const top = candidates.slice(0, limit).map(n => ({
    name: n.name, file: n.filePath, className: n.className ?? null, language: n.language,
    fanIn: n.fanIn ?? 0, fanOut: n.fanOut ?? 0,
    riskScore: computeRiskScore(n, 0, false),
    rationale: 'Low fan-in, low fan-out, not a hub — safe to rename, extract, or rewrite.',
  }));

  return {
    total: candidates.length, returned: top.length, candidates: top,
    tip: 'Start with the first candidate and work downward. Each can be changed in isolation.',
  };
}

/**
 * Return leaf functions (fan-out === 0).
 */
export async function handleGetLeafFunctions(
  directory: string,
  limit = LEAF_FUNCTIONS_DEFAULT_LIMIT,
  filePattern?: string,
  sortBy: 'fanIn' | 'name' | 'file' = 'fanIn'
): Promise<unknown> {
  limit = Math.max(1, Math.min(limit, 500));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const hasOutgoing = new Set(cg.edges.filter(e => e.calleeId).map(e => e.callerId));
  let leaves = cg.nodes.filter(n => !n.isExternal && !n.isTest && !hasOutgoing.has(n.id));

  if (filePattern) leaves = leaves.filter(n => n.filePath.includes(filePattern));

  leaves.sort((a, b) => {
    if (sortBy === 'fanIn') return (b.fanIn ?? 0) - (a.fanIn ?? 0);
    if (sortBy === 'name')  return a.name.localeCompare(b.name);
    return a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name);
  });

  const top = leaves.slice(0, limit).map(n => ({
    name: n.name, file: n.filePath, className: n.className ?? null, language: n.language,
    fanIn: n.fanIn ?? 0, fanOut: 0, blastRadius: 0,
    riskScore: computeRiskScore(n, 0, false),
    refactorAdvice: (n.fanIn ?? 0) === 0
      ? 'Unreachable or dead code — safe to delete after confirmation.'
      : 'Pure leaf: rewrite freely, then re-run tests for its callers.',
  }));

  return {
    totalLeaves: leaves.length, returned: top.length, sortedBy: sortBy, leaves: top,
    insight: 'Refactoring leaves bottom-up lets you build confidence and test coverage before tackling higher-risk hubs.',
  };
}

/**
 * Return critical hub functions ranked by composite criticality.
 */
export async function handleGetCriticalHubs(
  directory: string,
  limit = 10,
  minFanIn = CRITICAL_HUBS_DEFAULT_MIN_FAN_IN
): Promise<unknown> {
  limit = Math.max(1, Math.min(limit, 500));
  minFanIn = Math.max(1, Math.min(minFanIn, 100));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const violatorFiles = new Set(
    cg.layerViolations.flatMap(v =>
      [nodeMap.get(v.callerId)?.filePath, nodeMap.get(v.calleeId)?.filePath].filter(Boolean) as string[]
    )
  );

  const hubs = cg.nodes
    .filter(n => !n.isExternal && !n.isTest && (n.fanIn ?? 0) >= minFanIn)
    .map(n => {
      const fanIn        = n.fanIn  ?? 0;
      const fanOut       = n.fanOut ?? 0;
      const hasViolation = violatorFiles.has(n.filePath);
      const criticality  = fanIn * CRITICALITY_FAN_IN_WEIGHT + fanOut * CRITICALITY_FAN_OUT_WEIGHT + (hasViolation ? CRITICALITY_VIOLATION_BONUS : 0);
      const stabilityScore = Math.max(0, Math.round(100 - Math.min(100, criticality)));

      let approach: string;
      let approachRationale: string;
      if (fanIn >= HUB_HIGH_FAN_IN_THRESHOLD && fanOut >= HUB_HIGH_FAN_OUT_THRESHOLD) {
        approach = 'split responsibility';
        approachRationale = 'God-function: extract cohesive groups of callees into dedicated modules and expose a minimal coordinator interface.';
      } else if (fanIn >= HUB_HIGH_FAN_IN_THRESHOLD) {
        approach = 'introduce façade';
        approachRationale = 'Heavily depended-upon: keep the signature stable, move implementation behind a façade, then migrate callers to the new interface over time.';
      } else if (fanOut >= HUB_HIGH_FAN_OUT_THRESHOLD) {
        approach = 'delegate';
        approachRationale = "Too many outgoing calls: extract groups of related calls into helper services and delegate to them, reducing this function's orchestration burden.";
      } else {
        approach = 'extract';
        approachRationale = 'Moderate hub: identify the core responsibility, extract secondary logic into well-named helpers, and add integration tests before changing callers.';
      }

      return {
        name: n.name, file: n.filePath, className: n.className ?? null, language: n.language,
        fanIn, fanOut, hasLayerViolation: hasViolation,
        criticality: Math.round(criticality * 10) / 10,
        stabilityScore,
        riskScore: computeRiskScore(n, fanIn + fanOut, true),
        recommendedApproach: { approach, rationale: approachRationale },
        refactoringOrder:
          stabilityScore >= STABILITY_SCORE_CAN_REFACTOR ? 'can refactor now with good test coverage'
          : stabilityScore >= STABILITY_SCORE_STABILISE_FIRST ? 'refactor after stabilising its leaf dependencies'
          : 'defer — stabilise surrounding code first, then tackle incrementally',
      };
    })
    .sort((a, b) => b.criticality - a.criticality)
    .slice(0, limit);

  return {
    totalHubs: cg.nodes.filter(n => !n.isExternal && !n.isTest && (n.fanIn ?? 0) >= minFanIn).length,
    returned: hubs.length, minFanIn, hubs,
    guidance: 'Start with hubs that have the highest stabilityScore (easiest wins). Defer hubs with stabilityScore < 30 until their dependencies are cleaner.',
  };
}

/**
 * Detect god functions (high fan-out) and return their call-graph neighborhood.
 */
export async function handleGetGodFunctions(
  directory: string,
  filePath?: string,
  fanOutThreshold = GOD_FUNCTION_FAN_OUT_THRESHOLD,
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  let candidates: FunctionNode[];
  if (filePath) {
    candidates = getFileGodFunctions(cg, filePath, fanOutThreshold);
  } else {
    candidates = cg.nodes.filter(n => !n.isExternal && !n.isTest && n.fanOut >= fanOutThreshold);
  }

  if (candidates.length === 0) {
    return { threshold: fanOutThreshold, count: 0, godFunctions: [], message: `No god functions found with fanOut >= ${fanOutThreshold}` };
  }

  const godFunctions = candidates
    .sort((a, b) => b.fanOut - a.fanOut)
    .map(fn => {
      const sub = extractSubgraph(cg, fn);
      const directCallees = [...new Set(sub.edges.filter(([from]) => from === fn.name).map(([, to]) => to))];
      return { name: fn.name, file: fn.filePath, className: fn.className, fanIn: fn.fanIn, fanOut: fn.fanOut, directCallees, subgraphNodes: sub.nodes.length };
    });

  return { threshold: fanOutThreshold, count: godFunctions.length, godFunctions };
}

/**
 * Return the file-level import dependencies for a given file.
 *
 * Uses the dependency-graph.json produced by `spec-gen analyze`.
 * direction:
 *   "imports"  — files this file depends on (outgoing edges)
 *   "importedBy" — files that depend on this file (incoming edges)
 *   "both"     — both directions
 */
export async function handleGetFileDependencies(
  directory: string,
  filePath: string,
  direction: 'imports' | 'importedBy' | 'both' = 'both',
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const depGraphPath = join(absDir, '.spec-gen', 'analysis', 'dependency-graph.json');

  interface DepEdge {
    source: string;
    target: string;
    importedNames: string[];
    isTypeOnly: boolean;
    weight: number;
  }
  interface DepNode {
    id: string;
    file: { path: string; absolutePath: string };
  }
  interface DepGraph { nodes: DepNode[]; edges: DepEdge[] }

  let graph: DepGraph;
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(depGraphPath, 'utf-8');
    graph = JSON.parse(raw) as DepGraph;
  } catch {
    return { error: 'No dependency graph found. Run "spec-gen analyze" first.' };
  }

  // Resolve the file path to the same form used in the graph (relative or absolute)
  const node = graph.nodes.find(
    n => n.file.path === filePath || n.file.absolutePath.endsWith('/' + filePath.replace(/^\//, ''))
  );
  if (!node) {
    return { error: `File not found in dependency graph: ${filePath}`, hint: 'Use a relative path from the project root, e.g. "src/core/analyzer/vector-index.ts"' };
  }

  const nodeIdToPath = new Map(graph.nodes.map(n => [n.id, n.file.path]));

  const imports = (direction === 'imports' || direction === 'both')
    ? graph.edges
        .filter(e => e.source === node.id)
        .map(e => ({
          filePath: nodeIdToPath.get(e.target) ?? e.target,
          importedNames: e.importedNames,
          isTypeOnly: e.isTypeOnly,
        }))
    : undefined;

  const importedBy = (direction === 'importedBy' || direction === 'both')
    ? graph.edges
        .filter(e => e.target === node.id)
        .map(e => ({
          filePath: nodeIdToPath.get(e.source) ?? e.source,
          importedNames: e.importedNames,
          isTypeOnly: e.isTypeOnly,
        }))
    : undefined;

  return {
    filePath: node.file.path,
    direction,
    importsCount: imports?.length ?? null,
    importedByCount: importedBy?.length ?? null,
    imports,
    importedBy,
  };
}

/**
 * Find all execution paths between two functions in the call graph.
 * Useful for debugging: "how does request X reach function Y?",
 * "which call chain produced this error?".
 *
 * Uses DFS with visited-set cycle detection. Returns paths ordered
 * by hop count (shortest first), capped at maxPaths.
 */
export async function handleTraceExecutionPath(
  directory: string,
  entryFunction: string,
  targetFunction: string,
  maxDepth = TRACE_PATH_DEFAULT_MAX_DEPTH,
  maxPaths = TRACE_PATH_MAX_PATHS,
): Promise<unknown> {
  maxDepth = Math.max(1, Math.min(maxDepth, SUBGRAPH_MAX_DEPTH_LIMIT));
  maxPaths = Math.max(1, Math.min(maxPaths, 50));

  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const { nodeMap, forward } = buildAdjacency(cg);

  const entryLower  = entryFunction.toLowerCase();
  const targetLower = targetFunction.toLowerCase();
  const entryNodes  = cg.nodes.filter(n => n.name.toLowerCase().includes(entryLower));
  const targetNodes = cg.nodes.filter(n => n.name.toLowerCase().includes(targetLower));

  if (entryNodes.length === 0)  return { error: `No function matching "${entryFunction}" found in call graph.` };
  if (targetNodes.length === 0) return { error: `No function matching "${targetFunction}" found in call graph.` };

  const targetIds = new Set(targetNodes.map(n => n.id));
  const allPaths: string[][] = [];

  function dfs(currentId: string, path: string[], visited: Set<string>): void {
    if (allPaths.length >= maxPaths) return;
    if (targetIds.has(currentId) && path.length > 1) {
      allPaths.push([...path]);
      return; // don't traverse past the target
    }
    if (path.length > maxDepth) return;
    for (const neighborId of forward.get(currentId) ?? []) {
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        path.push(neighborId);
        dfs(neighborId, path, visited);
        path.pop();
        visited.delete(neighborId);
      }
    }
  }

  for (const entry of entryNodes) {
    if (allPaths.length >= maxPaths) break;
    dfs(entry.id, [entry.id], new Set([entry.id]));
  }

  if (allPaths.length === 0) {
    return {
      entryFunction,
      targetFunction,
      pathsFound: 0,
      message: `No execution path found from "${entryFunction}" to "${targetFunction}" within depth ${maxDepth}.`,
      hint: 'Try increasing maxDepth, or check whether both functions are in the same connected component of the call graph.',
    };
  }

  allPaths.sort((a, b) => a.length - b.length);

  const paths = allPaths.map(pathIds => {
    const steps = pathIds.map(id => {
      const node = nodeMap.get(id);
      return node
        ? { name: node.name, file: node.filePath, className: node.className ?? null }
        : { name: id, file: '', className: null };
    });
    return {
      hops: pathIds.length - 1,
      chain: steps.map(s => s.name).join(' → '),
      steps,
    };
  });

  return {
    entryFunction:  entryNodes[0].name,
    targetFunction: targetNodes[0].name,
    pathsFound: paths.length,
    maxDepth,
    shortestPath: paths[0].chain,
    paths,
  };
}
