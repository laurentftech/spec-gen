/**
 * Refactoring Priority Analyzer
 *
 * Combines call graph metrics with requirement mappings to produce a
 * prioritized list of refactoring candidates. Output is a flat JSON array
 * suitable for consumption by a coding assistant.
 *
 * Metrics per function:
 *   fanIn        — number of internal callers
 *   fanOut       — number of internal callees
 *   depth        — hops from nearest entry point (-1 = unreachable)
 *   sccSize      — strongly connected component size (>1 = in a cycle)
 *   requirements — list of requirement names this function implements
 *
 * Issues detected:
 *   unreachable       — not reachable from any entry point AND no requirements
 *   high_fan_in       — fanIn >= HIGH_FAN_IN (likely hub utility)
 *   high_fan_out      — fanOut >= HIGH_FAN_OUT (likely god function / orchestrator)
 *   multi_requirement — implements > SRP_MAX requirements (SRP violation)
 *   in_cycle          — part of a cyclic dependency (sccSize > 1)
 */

import type { SerializedCallGraph, FunctionNode } from './call-graph.js';

// ============================================================================
// THRESHOLDS
// ============================================================================

const HIGH_FAN_IN = 8;
const HIGH_FAN_OUT = 8;
const SRP_MAX_REQUIREMENTS = 2;

/**
 * File path patterns for cross-cutting utility/logging modules.
 * Functions in these files that are pure sinks (fanOut === 0) are designed to be
 * called from everywhere — flagging them as hub overloads is noise, not signal.
 */
const UTILITY_PATH_PATTERNS = [
  /\/logger\.[^/]+$/i,
  /\/logging\.[^/]+$/i,
  /\/log\.[^/]+$/i,
  /\/utils\//i,
  /\/helpers\//i,
  /\/common\//i,
  /\/shared\//i,
];

/** Returns true if a high-fanIn node is a cross-cutting utility sink by design. */
function isCrossCuttingHub(node: FunctionNode): boolean {
  return node.fanOut === 0 && UTILITY_PATH_PATTERNS.some(p => p.test(node.filePath));
}

// ============================================================================
// TYPES
// ============================================================================

export type RefactorIssue =
  | 'unreachable'
  | 'high_fan_in'
  | 'high_fan_out'
  | 'multi_requirement'
  | 'in_cycle';

export interface RefactorEntry {
  function: string;
  file: string;
  className?: string;
  fanIn: number;
  fanOut: number;
  /** Hops from nearest entry point. -1 = unreachable */
  depth: number;
  /** SCC size. 1 = no cycle. >1 = part of a cycle */
  sccSize: number;
  /** Requirement names this function is mapped to */
  requirements: string[];
  issues: RefactorIssue[];
  /** Composite priority score for sorting (higher = more urgent) */
  priorityScore: number;
}

export interface CycleSummary {
  sccId: number;
  size: number;
  participants: Array<{ function: string; file: string }>;
}

export interface RefactorReport {
  generatedAt: string;
  stats: {
    totalFunctions: number;
    withIssues: number;
    unreachable: number;
    highFanIn: number;
    highFanOut: number;
    srpViolations: number;
    cycleParticipants: number;
    cyclesDetected: number;
  };
  /** Functions with at least one issue, sorted by priorityScore descending */
  priorities: RefactorEntry[];
  cycles: CycleSummary[];
}

export interface MappingEntry {
  requirement: string;
  functions: Array<{ name: string; file: string }>;
}

// ============================================================================
// DEPTH CALCULATION (BFS from entry points)
// ============================================================================

function computeDepths(
  nodes: FunctionNode[],
  edges: SerializedCallGraph['edges']
): Map<string, number> {
  // Forward adjacency list
  const adj = new Map<string, string[]>();
  for (const node of nodes) adj.set(node.id, []);
  for (const edge of edges) {
    if (edge.calleeId) {
      const list = adj.get(edge.callerId);
      if (list) list.push(edge.calleeId);
    }
  }

  const depths = new Map<string, number>();
  const queue: string[] = [];

  // Entry points (no internal callers) start at depth 0
  for (const node of nodes) {
    if (node.fanIn === 0) {
      depths.set(node.id, 0);
      queue.push(node.id);
    }
  }

  // BFS
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const d = depths.get(id)!;
    for (const calleeId of adj.get(id) ?? []) {
      if (!depths.has(calleeId)) {
        depths.set(calleeId, d + 1);
        queue.push(calleeId);
      }
    }
  }

  // Unreachable nodes get depth -1
  for (const node of nodes) {
    if (!depths.has(node.id)) {
      depths.set(node.id, -1);
    }
  }

  return depths;
}

// ============================================================================
// SCC — TARJAN'S ALGORITHM (iterative to avoid stack overflow)
// ============================================================================

function computeSCCs(
  nodes: FunctionNode[],
  edges: SerializedCallGraph['edges']
): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const node of nodes) adj.set(node.id, []);
  for (const edge of edges) {
    if (edge.calleeId) {
      const list = adj.get(edge.callerId);
      if (list) list.push(edge.calleeId);
    }
  }

  const sccMap = new Map<string, number>(); // nodeId → sccId
  const indexMap = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  let sccId = 0;

  // Iterative Tarjan's using explicit call stack
  for (const startNode of nodes) {
    if (indexMap.has(startNode.id)) continue;

    // Each frame: { nodeId, neighborIndex, index }
    const callStack: Array<{ id: string; neighborIdx: number }> = [
      { id: startNode.id, neighborIdx: 0 },
    ];

    indexMap.set(startNode.id, counter);
    lowlink.set(startNode.id, counter);
    counter++;
    stack.push(startNode.id);
    onStack.add(startNode.id);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const neighbors = adj.get(frame.id) ?? [];

      if (frame.neighborIdx < neighbors.length) {
        const w = neighbors[frame.neighborIdx++];

        if (!indexMap.has(w)) {
          callStack.push({ id: w, neighborIdx: 0 });
          indexMap.set(w, counter);
          lowlink.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
        } else if (onStack.has(w)) {
          lowlink.set(frame.id, Math.min(lowlink.get(frame.id)!, indexMap.get(w)!));
        }
      } else {
        // Done with this node
        callStack.pop();

        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1];
          lowlink.set(
            parent.id,
            Math.min(lowlink.get(parent.id)!, lowlink.get(frame.id)!)
          );
        }

        // If root of SCC
        if (lowlink.get(frame.id) === indexMap.get(frame.id)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
            sccMap.set(w, sccId);
          } while (w !== frame.id);
          sccId++;
        }
      }
    }
  }

  return sccMap;
}

// ============================================================================
// MAIN ANALYZER
// ============================================================================

/**
 * Analyze a call graph for refactoring priorities.
 *
 * @param callGraph   Serialized call graph from the analyzer
 * @param mappings    Optional: requirement mappings from mapping.json
 */
export function analyzeForRefactoring(
  callGraph: SerializedCallGraph,
  mappings?: MappingEntry[]
): RefactorReport {
  const nodes = callGraph.nodes;
  const edges = callGraph.edges;

  // Build requirement reverse index: functionKey → requirement names
  // Key format: "name@filePath" (partial match — file suffix match)
  const reqByFn = new Map<string, string[]>(); // functionId → requirement names

  if (mappings && mappings.length > 0) {
    for (const mapping of mappings) {
      for (const fn of mapping.functions) {
        // Match against call graph nodes
        for (const node of nodes) {
          const pathMatch =
            node.filePath === fn.file ||
            node.filePath.endsWith('/' + fn.file) ||
            fn.file.endsWith('/' + node.filePath) ||
            fn.file === node.filePath;
          if (pathMatch && node.name === fn.name) {
            const existing = reqByFn.get(node.id) ?? [];
            if (!existing.includes(mapping.requirement)) {
              existing.push(mapping.requirement);
            }
            reqByFn.set(node.id, existing);
          }
        }
      }
    }
  }

  // Compute depths and SCCs
  const depths = computeDepths(nodes, edges);
  const sccMap = computeSCCs(nodes, edges);

  // Compute SCC sizes
  const sccSizes = new Map<number, number>();
  for (const sccId of sccMap.values()) {
    sccSizes.set(sccId, (sccSizes.get(sccId) ?? 0) + 1);
  }

  // Build RefactorEntry per function
  const entries: RefactorEntry[] = [];

  for (const node of nodes) {
    const requirements = reqByFn.get(node.id) ?? [];
    const depth = depths.get(node.id) ?? -1;
    const sccId = sccMap.get(node.id) ?? -1;
    const sccSize = sccId >= 0 ? (sccSizes.get(sccId) ?? 1) : 1;

    const issues: RefactorIssue[] = [];

    if (depth === -1 && requirements.length === 0) {
      issues.push('unreachable');
    }
    if (node.fanIn >= HIGH_FAN_IN && !isCrossCuttingHub(node)) {
      issues.push('high_fan_in');
    }
    if (node.fanOut >= HIGH_FAN_OUT) {
      issues.push('high_fan_out');
    }
    if (requirements.length > SRP_MAX_REQUIREMENTS) {
      issues.push('multi_requirement');
    }
    if (sccSize > 1) {
      issues.push('in_cycle');
    }

    const priorityScore = computePriorityScore(node, depth, sccSize, requirements.length, issues);

    entries.push({
      function: node.name,
      file: node.filePath,
      ...(node.className ? { className: node.className } : {}),
      fanIn: node.fanIn,
      fanOut: node.fanOut,
      depth,
      sccSize,
      requirements,
      issues,
      priorityScore,
    });
  }

  // Sort by priorityScore descending, filter to those with issues
  const withIssues = entries
    .filter(e => e.issues.length > 0)
    .sort((a, b) => b.priorityScore - a.priorityScore);

  // Build cycles summary (SCCs with size > 1)
  const cycleSCCs = new Map<number, CycleSummary>();
  for (const node of nodes) {
    const sccId = sccMap.get(node.id) ?? -1;
    const size = sccId >= 0 ? (sccSizes.get(sccId) ?? 1) : 1;
    if (size > 1) {
      if (!cycleSCCs.has(sccId)) {
        cycleSCCs.set(sccId, { sccId, size, participants: [] });
      }
      cycleSCCs.get(sccId)!.participants.push({
        function: node.name,
        file: node.filePath,
      });
    }
  }

  const cycles = Array.from(cycleSCCs.values());

  // Stats
  const unreachableCount = entries.filter(e => e.issues.includes('unreachable')).length;
  const highFanInCount = entries.filter(e => e.issues.includes('high_fan_in')).length;
  const highFanOutCount = entries.filter(e => e.issues.includes('high_fan_out')).length;
  const srpCount = entries.filter(e => e.issues.includes('multi_requirement')).length;
  const cycleParticipants = entries.filter(e => e.issues.includes('in_cycle')).length;

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      totalFunctions: nodes.length,
      withIssues: withIssues.length,
      unreachable: unreachableCount,
      highFanIn: highFanInCount,
      highFanOut: highFanOutCount,
      srpViolations: srpCount,
      cycleParticipants,
      cyclesDetected: cycles.length,
    },
    priorities: withIssues,
    cycles,
  };
}

function computePriorityScore(
  node: FunctionNode,
  depth: number,
  sccSize: number,
  reqCount: number,
  issues: RefactorIssue[]
): number {
  let score = 0;

  // Dead code — low urgency but worth flagging
  if (issues.includes('unreachable')) score += 1;

  // High fan-in: score proportional to excess
  if (node.fanIn >= HIGH_FAN_IN) {
    score += 2 + Math.min(3, (node.fanIn - HIGH_FAN_IN) / HIGH_FAN_IN);
  }

  // High fan-out: score proportional to excess
  if (node.fanOut >= HIGH_FAN_OUT) {
    score += 2 + Math.min(3, (node.fanOut - HIGH_FAN_OUT) / HIGH_FAN_OUT);
  }

  // SRP violation: +1 per requirement above threshold
  if (reqCount > SRP_MAX_REQUIREMENTS) {
    score += 1.5 + (reqCount - SRP_MAX_REQUIREMENTS) * 0.5;
  }

  // Cycles: +2 per cycle participant
  if (sccSize > 1) score += 2;

  // Depth bonus: shallower functions are more impactful to refactor
  if (depth >= 0 && depth <= 2 && issues.length > 0) score += 0.5;

  return Math.round(score * 10) / 10;
}
