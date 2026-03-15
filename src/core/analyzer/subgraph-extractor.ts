/**
 * Subgraph Extractor
 *
 * For files that are too large to send as raw source to the LLM,
 * extracts a compact call-graph neighborhood around "god functions"
 * (high fan-out) and formats it as a structured prompt section.
 *
 * This dramatically reduces token usage while preserving structural
 * information about complex orchestration code.
 */

import type { SerializedCallGraph, FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';

// Fan-out threshold for god-function detection (matches refactor-analyzer.ts)
const GOD_FANOUT_THRESHOLD = 8;

// Default max graph depth and nodes per subgraph
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_NODES = 30;

/** Approx tokens per node in the prompt section (name + file + stats) */
const TOKENS_PER_NODE = 20;

export interface SubgraphOptions {
  maxDepth?: number;
  maxNodes?: number;
  /** If provided, derive maxDepth/maxNodes from the token budget */
  tokenBudget?: number;
}

/** Derive a reasonable maxDepth from a token budget (rough heuristic). */
export function depthFromBudget(tokenBudget: number): number {
  // At depth=1: ~10 nodes avg, depth=2: ~30, depth=3: ~90
  const maxNodes = Math.floor(tokenBudget / TOKENS_PER_NODE);
  if (maxNodes <= 10) return 1;
  if (maxNodes <= 30) return 2;
  return 3;
}

// ============================================================================
// TYPES
// ============================================================================

export interface SubGraphNode {
  name: string;
  file: string;
  fanIn: number;
  fanOut: number;
}

export interface SubGraph {
  root: SubGraphNode;
  /** Callee nodes reachable within MAX_DEPTH */
  nodes: SubGraphNode[];
  /** [callerName, calleeName] pairs */
  edges: Array<[string, string]>;
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Return all god functions (fanOut >= threshold) defined in a given file.
 * Normalises path separators for cross-platform matching.
 */
export function getFileGodFunctions(
  callGraph: SerializedCallGraph,
  filePath: string,
  fanOutThreshold = GOD_FANOUT_THRESHOLD,
): FunctionNode[] {
  const normalised = filePath.replace(/\\/g, '/');
  return callGraph.nodes.filter(
    n => n.filePath.replace(/\\/g, '/').endsWith(normalised) && n.fanOut >= fanOutThreshold,
  );
}

/**
 * Extract a depth-limited subgraph around a root node.
 * Only follows outgoing (callee) edges.
 */
export function extractSubgraph(
  callGraph: SerializedCallGraph,
  root: FunctionNode,
  options: SubgraphOptions = {},
): SubGraph {
  const maxDepth = options.tokenBudget !== undefined
    ? depthFromBudget(options.tokenBudget)
    : (options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxNodes = options.tokenBudget !== undefined
    ? Math.floor(options.tokenBudget / TOKENS_PER_NODE)
    : (options.maxNodes ?? DEFAULT_MAX_NODES);

  const nodeMap = new Map<string, FunctionNode>(callGraph.nodes.map(n => [n.id, n]));
  const visited = new Set<string>();
  const resultNodes: SubGraphNode[] = [];
  const edges: Array<[string, string]> = [];

  function visit(nodeId: string, depth: number): void {
    if (visited.has(nodeId) || depth > maxDepth || visited.size >= maxNodes) return;
    visited.add(nodeId);

    const outgoing = callGraph.edges.filter(e => e.callerId === nodeId && e.calleeId);
    for (const edge of outgoing) {
      const callerNode = nodeMap.get(edge.callerId);
      const calleeNode = nodeMap.get(edge.calleeId);
      if (!callerNode || !calleeNode) continue;

      edges.push([callerNode.name, calleeNode.name]);

      if (!visited.has(edge.calleeId)) {
        resultNodes.push({
          name: calleeNode.name,
          file: calleeNode.filePath,
          fanIn: calleeNode.fanIn,
          fanOut: calleeNode.fanOut,
        });
        visit(edge.calleeId, depth + 1);
      }
    }
  }

  visit(root.id, 0);

  return {
    root: {
      name: root.name,
      file: root.filePath,
      fanIn: root.fanIn,
      fanOut: root.fanOut,
    },
    nodes: resultNodes,
    edges,
  };
}

/**
 * Format a single subgraph as a compact ASCII block for LLM prompts.
 *
 * Example output:
 *   run (fanIn=0, fanOut=12)
 *     → runStage1, runStage2, runStage3 ...
 */
function formatSubgraph(sub: SubGraph): string {
  const lines: string[] = [];
  lines.push(`${sub.root.name} (fanIn=${sub.root.fanIn}, fanOut=${sub.root.fanOut})`);

  // Direct callees of root
  const directCallees = sub.edges
    .filter(([from]) => from === sub.root.name)
    .map(([, to]) => to);

  if (directCallees.length > 0) {
    lines.push(`  → ${directCallees.join(', ')}`);
  }

  // Second-level callees
  const secondLevel = sub.edges.filter(([from]) => from !== sub.root.name);
  for (const [from, to] of secondLevel) {
    lines.push(`    ${from} → ${to}`);
  }

  return lines.join('\n');
}

/**
 * Build a graph-based prompt section for a large file.
 *
 * Returns null if no call-graph data is available for the file,
 * signalling the caller to fall back to raw source chunking.
 */
export function buildGraphPromptSection(
  callGraph: SerializedCallGraph | undefined,
  signatures: FileSignatureMap[] | undefined,
  filePath: string,
  tokenBudget?: number,
): string | null {
  if (!callGraph) return null;
  const godFunctions = getFileGodFunctions(callGraph, filePath);

  // No god functions means the graph adds little value; let caller chunk normally
  if (godFunctions.length === 0) return null;

  const lines: string[] = [
    `[Graph-based analysis — file too large to include full source]`,
    '',
  ];

  // Signatures for this file (from signature-extractor)
  const sigMap = signatures?.find(s =>
    s.path.replace(/\\/g, '/').endsWith(filePath.replace(/\\/g, '/')),
  );
  if (sigMap && sigMap.entries.length > 0) {
    lines.push('Signatures:');
    for (const entry of sigMap.entries) {
      const doc = entry.docstring ? `  // ${entry.docstring}` : '';
      lines.push(`  ${entry.signature}${doc}`);
    }
    lines.push('');
  }

  // Subgraphs for each god function
  lines.push(`High-complexity functions (fanOut >= ${GOD_FANOUT_THRESHOLD}):`);
  for (const godFn of godFunctions) {
    const sub = extractSubgraph(callGraph, godFn, tokenBudget !== undefined ? { tokenBudget } : {});
    lines.push(formatSubgraph(sub));
  }

  return lines.join('\n');
}
