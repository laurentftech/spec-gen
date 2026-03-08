/**
 * MCP tool handlers for call-graph analysis:
 * get_call_graph, get_subgraph, analyze_impact, get_critical_hubs,
 * get_leaf_functions, get_low_risk_refactor_candidates, get_god_functions.
 */

import { validateDirectory, readCachedContext } from './utils.js';
import { join } from 'node:path';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';
import { getFileGodFunctions, extractSubgraph } from '../../analyzer/subgraph-extractor.js';
import { readSpecGenConfig } from '../config-manager.js';

// ============================================================================
// SHARED GRAPH HELPERS (also exported for chat-tools.ts)
// ============================================================================

/**
 * Build forward (caller→callees) and backward (callee→callers) adjacency maps
 * from a serialised call graph, returning both maps and a node lookup.
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
    forward.get(e.callerId)?.add(e.calleeId);
    backward.get(e.calleeId)?.add(e.callerId);
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
 * Compute a risk score [0–100] for a node.
 *
 * Weights: fan-in × 4, fan-out × 2, isHub × 20, blastRadius × 1.5. Capped at 100.
 */
export function computeRiskScore(node: FunctionNode, blastRadius: number, isHub: boolean): number {
  const raw =
    (node.fanIn  ?? 0) * 4 +
    (node.fanOut ?? 0) * 2 +
    (isHub ? 20 : 0) +
    blastRadius * 1.5;
  return Math.min(100, Math.round(raw));
}

/** Derive a plain-language refactoring strategy from the risk profile. */
export function recommendStrategy(
  riskScore: number,
  fanIn: number,
  fanOut: number,
  isHub: boolean
): { approach: string; rationale: string } {
  if (riskScore <= 20) {
    return {
      approach: 'refactor freely',
      rationale:
        'Low fan-in and fan-out. Safe to rename, extract, or rewrite inline. ' +
        'A single PR with unit tests is sufficient.',
    };
  }
  if (riskScore <= 45) {
    return {
      approach: 'refactor with tests',
      rationale:
        'Moderate caller count. Write characterisation tests before changing the signature. ' +
        'Prefer additive changes (new overload / wrapper) then migrate callers.',
    };
  }
  if (isHub && fanOut > 5) {
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
  if (fanOut > 8) {
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
  maxDepth = 3,
  format: 'json' | 'mermaid' = 'json'
): Promise<unknown> {
  maxDepth = Math.max(1, Math.min(maxDepth, 20));
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);

  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available in cached analysis. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const lower = functionName.toLowerCase();
  let seeds = cg.nodes.filter(n => n.name.toLowerCase().includes(lower));

  // Fallback to semantic search if no exact substring match
  if (seeds.length === 0) {
    try {
      const { VectorIndex } = await import('../../analyzer/vector-index.js');
      const { EmbeddingService } = await import('../../analyzer/embedding-service.js');
      const outputDir = join(absDir, '.spec-gen', 'analysis');

      if (VectorIndex.exists(outputDir)) {
        let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
        try { embedSvc = EmbeddingService.fromEnv(); } catch {
          const cfg = await readSpecGenConfig(absDir);
          if (cfg?.embedding) embedSvc = EmbeddingService.fromConfig(cfg) ?? null;
        }
        if (embedSvc) {
          const results = await VectorIndex.search(outputDir, functionName, embedSvc, { limit: 1 });
          if (results.length > 0) {
            const top = results[0].record;
            const matched = cg.nodes.find(n => n.id === top.id);
            if (matched) seeds = [matched];
          }
        }
      }
    } catch { /* ignore fallback errors */ }
  }

  if (seeds.length === 0) return { error: `No function matching "${functionName}" found in call graph.` };

  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const node of cg.nodes) { forward.set(node.id, []); backward.set(node.id, []); }
  for (const edge of cg.edges) {
    if (!edge.calleeId) continue;
    forward.get(edge.callerId)?.push(edge.calleeId);
    backward.get(edge.calleeId)?.push(edge.callerId);
  }

  const visitedIds = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = seeds.map(n => ({ id: n.id, depth: 0 }));
  for (const seed of seeds) visitedIds.add(seed.id);

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    const neighbours: string[] = [];
    if (direction === 'downstream' || direction === 'both') neighbours.push(...(forward.get(id) ?? []));
    if (direction === 'upstream'   || direction === 'both') neighbours.push(...(backward.get(id) ?? []));
    for (const nId of neighbours) {
      if (!visitedIds.has(nId)) { visitedIds.add(nId); queue.push({ id: nId, depth: depth + 1 }); }
    }
  }

  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const subNodes = Array.from(visitedIds)
    .map(id => nodeMap.get(id)!)
    .filter(Boolean)
    .map(n => ({
      name: n.name, file: n.filePath, className: n.className,
      fanIn: n.fanIn, fanOut: n.fanOut, language: n.language,
      isSeed: seeds.some(s => s.id === n.id),
    }));

  const subEdges = cg.edges
    .filter(e => e.calleeId && visitedIds.has(e.callerId) && visitedIds.has(e.calleeId))
    .map(e => ({
      caller: nodeMap.get(e.callerId)?.name ?? e.callerId,
      callee: nodeMap.get(e.calleeId)?.name ?? e.calleeId,
      callerFile: nodeMap.get(e.callerId)?.filePath,
      calleeFile: nodeMap.get(e.calleeId)?.filePath,
    }));

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

  if (!ctx)           return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const cg = ctx.callGraph as SerializedCallGraph;
  const { nodeMap, forward, backward } = buildAdjacency(cg);
  const hubIds = new Set(cg.hubFunctions.map(n => n.id));

  const lower = symbol.toLowerCase();
  let seeds = cg.nodes.filter(n => n.name.toLowerCase().includes(lower));

  // Fallback to semantic search if no exact substring match
  if (seeds.length === 0) {
    try {
      const { VectorIndex } = await import('../../analyzer/vector-index.js');
      const { EmbeddingService } = await import('../../analyzer/embedding-service.js');
      const outputDir = join(absDir, '.spec-gen', 'analysis');

      if (VectorIndex.exists(outputDir)) {
        let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
        try { embedSvc = EmbeddingService.fromEnv(); } catch {
          const cfg = await readSpecGenConfig(absDir);
          if (cfg?.embedding) embedSvc = EmbeddingService.fromConfig(cfg) ?? null;
        }
        if (embedSvc) {
          const results = await VectorIndex.search(outputDir, symbol, embedSvc, { limit: 1 });
          if (results.length > 0) {
            const top = results[0].record;
            const matched = cg.nodes.find(n => n.id === top.id);
            if (matched) seeds = [matched];
          }
        }
      }
    } catch { /* ignore fallback errors */ }
  }

  if (seeds.length === 0) return { error: `No function matching "${symbol}" found in call graph.` };

  const seedIds = seeds.map(n => n.id);
  const upstreamMap   = bfs(seedIds, backward, depth);
  const downstreamMap = bfs(seedIds, forward,  depth);

  const upstreamNodes = [...upstreamMap.entries()]
    .filter(([id]) => !seedIds.includes(id))
    .map(([id, d]) => ({ ...nodeToSummary(nodeMap.get(id)), depth: d }))
    .filter(n => n.name);

  const downstreamNodes = [...downstreamMap.entries()]
    .filter(([id]) => !seedIds.includes(id))
    .map(([id, d]) => ({ ...nodeToSummary(nodeMap.get(id)), depth: d }))
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
  limit = 5,
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
    return fanIn <= 2 && fanOut <= 3 && !hubIds.has(n.id) && !entryIds.has(n.id);
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
  limit = 20,
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
  let leaves = cg.nodes.filter(n => !hasOutgoing.has(n.id));

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
  minFanIn = 3
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
    .filter(n => (n.fanIn ?? 0) >= minFanIn)
    .map(n => {
      const fanIn        = n.fanIn  ?? 0;
      const fanOut       = n.fanOut ?? 0;
      const hasViolation = violatorFiles.has(n.filePath);
      const criticality  = fanIn * 3 + fanOut * 1.5 + (hasViolation ? 10 : 0);
      const stabilityScore = Math.max(0, Math.round(100 - Math.min(100, criticality)));

      let approach: string;
      let approachRationale: string;
      if (fanIn >= 8 && fanOut >= 5) {
        approach = 'split responsibility';
        approachRationale = 'God-function: extract cohesive groups of callees into dedicated modules and expose a minimal coordinator interface.';
      } else if (fanIn >= 8) {
        approach = 'introduce façade';
        approachRationale = 'Heavily depended-upon: keep the signature stable, move implementation behind a façade, then migrate callers to the new interface over time.';
      } else if (fanOut >= 5) {
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
          stabilityScore >= 60 ? 'can refactor now with good test coverage'
          : stabilityScore >= 30 ? 'refactor after stabilising its leaf dependencies'
          : 'defer — stabilise surrounding code first, then tackle incrementally',
      };
    })
    .sort((a, b) => b.criticality - a.criticality)
    .slice(0, limit);

  return {
    totalHubs: cg.nodes.filter(n => (n.fanIn ?? 0) >= minFanIn).length,
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
  fanOutThreshold = 8,
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
    candidates = cg.nodes.filter(n => n.fanOut >= fanOutThreshold);
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
