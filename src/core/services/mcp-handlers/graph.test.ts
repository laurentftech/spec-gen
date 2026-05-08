/**
 * Tests for graph.ts pure utility functions:
 * buildAdjacency, bfs, computeRiskScore, recommendStrategy, nodeToSummary
 * Plus error-path tests for the async handlers.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';

// Mock node:fs/promises so handleGetFileDependencies can be tested without disk I/O.
// Default: readFile throws (simulates missing dep-graph file).
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
}));

// Static mocks for handler tests
vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (dir: string) => dir),
  readCachedContext: vi.fn(async () => null),
  loadMappingIndex: vi.fn(async () => null),
  specsForFile: vi.fn(() => []),
  functionsForDomain: vi.fn(() => []),
  isCacheFresh: vi.fn(async () => false),
}));

import {
  buildAdjacency,
  bfs,
  computeRiskScore,
  recommendStrategy,
  nodeToSummary,
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleGetGodFunctions,
  handleGetFileDependencies,
  handleTraceExecutionPath,
} from './graph.js';
import { readCachedContext } from './utils.js';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

function makeNode(overrides: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: overrides.id.split('::')[1] ?? overrides.id,
    filePath: overrides.id.split('::')[0] ?? 'test.ts',
    isAsync: false,
    language: 'typescript',
    startIndex: 0,
    endIndex: 100,
    fanIn: 0,
    fanOut: 0,
    ...overrides,
  };
}

function makeEdge(callerId: string, calleeId: string): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1] ?? calleeId, confidence: 'name_only' };
}

function makeGraph(nodes: FunctionNode[], edges: CallEdge[]): SerializedCallGraph {
  return {
    nodes,
    edges,
    classes: [],
    inheritanceEdges: [],
    hubFunctions: [],
    entryPoints: [],
    layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
}

// ============================================================================
// buildAdjacency
// ============================================================================

describe('buildAdjacency', () => {
  it('should build forward and backward adjacency maps', () => {
    const a = makeNode({ id: 'a.ts::foo' });
    const b = makeNode({ id: 'b.ts::bar' });
    const c = makeNode({ id: 'c.ts::baz' });
    const cg = makeGraph([a, b, c], [makeEdge(a.id, b.id), makeEdge(a.id, c.id)]);

    const { forward, backward, nodeMap } = buildAdjacency(cg);

    // Forward: a → {b, c}
    expect(forward.get(a.id)!.has(b.id)).toBe(true);
    expect(forward.get(a.id)!.has(c.id)).toBe(true);
    expect(forward.get(b.id)!.size).toBe(0);

    // Backward: b ← {a}, c ← {a}
    expect(backward.get(b.id)!.has(a.id)).toBe(true);
    expect(backward.get(c.id)!.has(a.id)).toBe(true);
    expect(backward.get(a.id)!.size).toBe(0);

    // nodeMap
    expect(nodeMap.get(a.id)).toBe(a);
    expect(nodeMap.size).toBe(3);
  });

  it('should handle empty graph', () => {
    const cg = makeGraph([], []);
    const { forward, backward, nodeMap } = buildAdjacency(cg);

    expect(forward.size).toBe(0);
    expect(backward.size).toBe(0);
    expect(nodeMap.size).toBe(0);
  });

  it('should skip edges with empty calleeId', () => {
    const a = makeNode({ id: 'a.ts::foo' });
    const cg = makeGraph([a], [{ callerId: a.id, calleeId: '', calleeName: 'external', confidence: 'name_only' }]);

    const { forward } = buildAdjacency(cg);
    expect(forward.get(a.id)!.size).toBe(0);
  });

  it('should handle diamond dependency graph', () => {
    const a = makeNode({ id: 'a.ts::a' });
    const b = makeNode({ id: 'b.ts::b' });
    const c = makeNode({ id: 'c.ts::c' });
    const d = makeNode({ id: 'd.ts::d' });
    // a → b, a → c, b → d, c → d
    const cg = makeGraph([a, b, c, d], [
      makeEdge(a.id, b.id), makeEdge(a.id, c.id),
      makeEdge(b.id, d.id), makeEdge(c.id, d.id),
    ]);

    const { backward } = buildAdjacency(cg);
    // d has two callers: b and c
    expect(backward.get(d.id)!.size).toBe(2);
    expect(backward.get(d.id)!.has(b.id)).toBe(true);
    expect(backward.get(d.id)!.has(c.id)).toBe(true);
  });
});

// ============================================================================
// bfs
// ============================================================================

describe('bfs', () => {
  it('should traverse to specified depth', () => {
    // Linear chain: a → b → c → d
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['d'])],
      ['d', new Set()],
    ]);

    const visited = bfs(['a'], adj, 2);
    expect(visited.get('a')).toBe(0);
    expect(visited.get('b')).toBe(1);
    expect(visited.get('c')).toBe(2);
    expect(visited.has('d')).toBe(false); // depth 3, beyond limit
  });

  it('should handle multiple seeds', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['c'])],
      ['b', new Set(['c'])],
      ['c', new Set(['d'])],
      ['d', new Set()],
    ]);

    const visited = bfs(['a', 'b'], adj, 1);
    expect(visited.get('a')).toBe(0);
    expect(visited.get('b')).toBe(0);
    expect(visited.get('c')).toBe(1);
    expect(visited.has('d')).toBe(false);
  });

  it('should handle cycles without infinite loop', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])], // cycle back
    ]);

    const visited = bfs(['a'], adj, 10);
    expect(visited.size).toBe(3);
    expect(visited.get('a')).toBe(0);
    expect(visited.get('b')).toBe(1);
    expect(visited.get('c')).toBe(2);
  });

  it('should return only seeds at depth 0', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set()],
    ]);

    const visited = bfs(['a'], adj, 0);
    expect(visited.size).toBe(1);
    expect(visited.get('a')).toBe(0);
  });

  it('should handle disconnected nodes', () => {
    const adj = new Map<string, Set<string>>([
      ['a', new Set()],
      ['b', new Set()],
    ]);

    const visited = bfs(['a'], adj, 5);
    expect(visited.size).toBe(1);
    expect(visited.has('b')).toBe(false);
  });
});

// ============================================================================
// computeRiskScore
// ============================================================================

describe('computeRiskScore', () => {
  it('should return 0 for a node with no connections and no hub status', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 0, fanOut: 0 });
    expect(computeRiskScore(node, 0, false)).toBe(0);
  });

  it('should weight fan-in by 4', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 5, fanOut: 0 });
    // 5 * 4 = 20
    expect(computeRiskScore(node, 0, false)).toBe(20);
  });

  it('should weight fan-out by 2', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 0, fanOut: 5 });
    // 5 * 2 = 10
    expect(computeRiskScore(node, 0, false)).toBe(10);
  });

  it('should add hub bonus of 20', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 0, fanOut: 0 });
    expect(computeRiskScore(node, 0, true)).toBe(20);
  });

  it('should weight blast radius by 1.5', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 0, fanOut: 0 });
    // 10 * 1.5 = 15
    expect(computeRiskScore(node, 10, false)).toBe(15);
  });

  it('should combine all factors', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 3, fanOut: 4 });
    // 3*4 + 4*2 + 20 + 5*1.5 = 12 + 8 + 20 + 7.5 = 47.5 → 48
    expect(computeRiskScore(node, 5, true)).toBe(48);
  });

  it('should cap at 100', () => {
    const node = makeNode({ id: 'test::fn', fanIn: 50, fanOut: 50 });
    // 50*4 + 50*2 + 20 + 100*1.5 = 200 + 100 + 20 + 150 = 470 → capped at 100
    expect(computeRiskScore(node, 100, true)).toBe(100);
  });
});

// ============================================================================
// recommendStrategy
// ============================================================================

describe('recommendStrategy', () => {
  it('should recommend "refactor freely" for low risk (<= 20)', () => {
    const result = recommendStrategy(10, 1, 1, false);
    expect(result.approach).toBe('refactor freely');
  });

  it('should recommend "refactor with tests" for medium risk (21-45)', () => {
    const result = recommendStrategy(30, 3, 3, false);
    expect(result.approach).toBe('refactor with tests');
  });

  it('should recommend "split responsibility" for high-risk hub with high fan-out', () => {
    // riskScore > 45, isHub = true, fanOut > REFACTOR_SRP_FAN_OUT_THRESHOLD (5)
    const result = recommendStrategy(80, 10, 10, true);
    expect(result.approach).toBe('split responsibility (SRP)');
  });

  it('should recommend "introduce façade" for hub without extreme fan-out', () => {
    // riskScore > 45, isHub = true, fanOut <= REFACTOR_SRP_FAN_OUT_THRESHOLD (5)
    const result = recommendStrategy(60, 10, 3, true);
    expect(result.approach).toBe('introduce façade');
  });

  it('should recommend "decompose fan-out" for non-hub with high fan-out', () => {
    // riskScore > 45, isHub = false, fanOut > GOD_FUNCTION_FAN_OUT_THRESHOLD (8)
    const result = recommendStrategy(50, 2, 12, false);
    expect(result.approach).toBe('decompose fan-out');
  });

  it('should fall back to "incremental extraction" for high risk non-hub, low fan-out', () => {
    // riskScore > 45, isHub = false, fanOut <= 8
    const result = recommendStrategy(50, 10, 3, false);
    expect(result.approach).toBe('incremental extraction');
  });

  it('should always include a rationale', () => {
    for (const [risk, fanIn, fanOut, isHub] of [
      [5, 0, 0, false], [30, 3, 3, false], [80, 10, 10, true],
      [60, 10, 3, true], [50, 2, 12, false], [50, 10, 3, false],
    ] as [number, number, number, boolean][]) {
      const result = recommendStrategy(risk, fanIn, fanOut, isHub);
      expect(result.rationale.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// nodeToSummary
// ============================================================================

describe('nodeToSummary', () => {
  it('should extract name, file, className, and depth from a node', () => {
    const node = makeNode({ id: 'src/auth.ts::AuthService.login', name: 'login', className: 'AuthService' });
    const summary = nodeToSummary(node);
    expect(summary.name).toBe('login');
    expect(summary.file).toBe('src/auth.ts');
    expect(summary.className).toBe('AuthService');
    expect(summary.depth).toBe(0);
  });

  it('should handle node without className', () => {
    const node = makeNode({ id: 'utils.ts::helper', name: 'helper' });
    const summary = nodeToSummary(node);
    expect(summary.className).toBeNull();
  });

  it('should return empty defaults for undefined node', () => {
    const summary = nodeToSummary(undefined);
    expect(summary.name).toBe('');
    expect(summary.file).toBe('');
    expect(summary.className).toBeNull();
    expect(summary.depth).toBe(0);
  });
});

// ============================================================================
// Handler error paths (readCachedContext returns null → error object)
// ============================================================================

describe('handler error paths — no cached context', () => {
  it('handleGetCallGraph returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetCallGraph('/tmp/proj') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetSubgraph returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetSubgraph('/tmp/proj', 'doFoo') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleAnalyzeImpact returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleAnalyzeImpact('/tmp/proj', 'doFoo') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetLowRiskRefactorCandidates returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetLowRiskRefactorCandidates('/tmp/proj') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetLeafFunctions returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetLeafFunctions('/tmp/proj') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetCriticalHubs returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetCriticalHubs('/tmp/proj') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetGodFunctions returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleGetGodFunctions('/tmp/proj') as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('handleGetFileDependencies returns error when no dependency graph file', async () => {
    // readCachedContext not involved here; it reads a JSON file directly
    const result = await handleGetFileDependencies('/tmp/proj', 'src/foo.ts') as { error: string };
    expect(result.error).toContain('No dependency graph found');
  });

  it('handleTraceExecutionPath returns error when no context', async () => {
    vi.mocked(readCachedContext).mockResolvedValue(null);
    const result = await handleTraceExecutionPath('/tmp/proj', 'foo', 'bar') as { error: string };
    expect(result.error).toContain('No analysis found');
  });
});

// ============================================================================
// handleTraceExecutionPath — path finding logic
// ============================================================================

describe('handleTraceExecutionPath', () => {
  it('finds the shortest direct path between two functions', async () => {
    const nodes = [
      makeNode({ id: 'a.ts::processOrder', fanOut: 1 }),
      makeNode({ id: 'b.ts::applyDiscounts', fanOut: 1 }),
      makeNode({ id: 'c.ts::chargeCard', fanOut: 0 }),
    ];
    const edges = [
      makeEdge('a.ts::processOrder', 'b.ts::applyDiscounts'),
      makeEdge('b.ts::applyDiscounts', 'c.ts::chargeCard'),
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, edges) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'processOrder', 'chargeCard') as {
      pathsFound: number;
      shortestPath: string;
      paths: Array<{ hops: number; chain: string }>;
    };

    expect(result.pathsFound).toBe(1);
    expect(result.paths[0].hops).toBe(2);
    expect(result.paths[0].chain).toBe('processOrder → applyDiscounts → chargeCard');
  });

  it('returns multiple paths ordered by length (shortest first)', async () => {
    // A → B → D  (2 hops)
    // A → C → D  (2 hops)
    const nodes = [
      makeNode({ id: 'f.ts::A', fanOut: 2 }),
      makeNode({ id: 'f.ts::B', fanOut: 1 }),
      makeNode({ id: 'f.ts::C', fanOut: 1 }),
      makeNode({ id: 'f.ts::D', fanOut: 0 }),
    ];
    const edges = [
      makeEdge('f.ts::A', 'f.ts::B'),
      makeEdge('f.ts::A', 'f.ts::C'),
      makeEdge('f.ts::B', 'f.ts::D'),
      makeEdge('f.ts::C', 'f.ts::D'),
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, edges) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'A', 'D') as {
      pathsFound: number;
      paths: Array<{ hops: number }>;
    };

    expect(result.pathsFound).toBe(2);
    expect(result.paths.every(p => p.hops === 2)).toBe(true);
  });

  it('returns pathsFound: 0 with a hint when no path exists', async () => {
    const nodes = [
      makeNode({ id: 'f.ts::isolated', fanOut: 0 }),
      makeNode({ id: 'f.ts::other', fanOut: 0 }),
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, []) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'isolated', 'other') as {
      pathsFound: number;
      hint: string;
    };

    expect(result.pathsFound).toBe(0);
    expect(result.hint).toBeDefined();
  });

  it('returns error when entry function is not found', async () => {
    const nodes = [makeNode({ id: 'f.ts::known', fanOut: 0 })];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, []) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'ghost', 'known') as { error: string };
    expect(result.error).toContain('"ghost"');
  });

  it('returns error when target function is not found', async () => {
    const nodes = [makeNode({ id: 'f.ts::known', fanOut: 0 })];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, []) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'known', 'ghost') as { error: string };
    expect(result.error).toContain('"ghost"');
  });

  it('respects maxDepth and does not return paths longer than the limit', async () => {
    // A → B → C → D (3 hops) — should be excluded when maxDepth=2
    const nodes = [
      makeNode({ id: 'f.ts::A', fanOut: 1 }),
      makeNode({ id: 'f.ts::B', fanOut: 1 }),
      makeNode({ id: 'f.ts::C', fanOut: 1 }),
      makeNode({ id: 'f.ts::D', fanOut: 0 }),
    ];
    const edges = [
      makeEdge('f.ts::A', 'f.ts::B'),
      makeEdge('f.ts::B', 'f.ts::C'),
      makeEdge('f.ts::C', 'f.ts::D'),
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: makeGraph(nodes, edges) } as never);

    const result = await handleTraceExecutionPath('/tmp/proj', 'A', 'D', 2) as { pathsFound: number };
    expect(result.pathsFound).toBe(0);
  });
});

// ============================================================================
// handleGetFileDependencies — direction branches
// ============================================================================

const DEP_GRAPH_FIXTURE = JSON.stringify({
  nodes: [
    { id: 'n1', file: { path: 'src/a.ts', absolutePath: '/proj/src/a.ts' } },
    { id: 'n2', file: { path: 'src/b.ts', absolutePath: '/proj/src/b.ts' } },
    { id: 'n3', file: { path: 'src/c.ts', absolutePath: '/proj/src/c.ts' } },
  ],
  edges: [
    { source: 'n1', target: 'n2', importedNames: ['foo'], isTypeOnly: false, weight: 1 },
    { source: 'n3', target: 'n1', importedNames: ['bar'], isTypeOnly: true,  weight: 1 },
  ],
});

describe('handleGetFileDependencies — direction branches', () => {
  afterEach(async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
  });

  async function mockDepGraph() {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readFile).mockResolvedValue(DEP_GRAPH_FIXTURE as never);
  }

  it('returns imports only when direction is "imports"', async () => {
    await mockDepGraph();
    const result = await handleGetFileDependencies('/proj', 'src/a.ts', 'imports') as {
      imports: unknown[]; importedBy: unknown; importsCount: number;
    };
    expect(result.imports).toHaveLength(1);
    expect(result.importedBy).toBeUndefined();
    expect(result.importsCount).toBe(1);
  });

  it('returns importedBy only when direction is "importedBy"', async () => {
    await mockDepGraph();
    const result = await handleGetFileDependencies('/proj', 'src/a.ts', 'importedBy') as {
      imports: unknown; importedBy: unknown[]; importedByCount: number;
    };
    expect(result.importedBy).toHaveLength(1);
    expect(result.imports).toBeUndefined();
    expect(result.importedByCount).toBe(1);
  });

  it('returns both imports and importedBy when direction is "both"', async () => {
    await mockDepGraph();
    const result = await handleGetFileDependencies('/proj', 'src/a.ts', 'both') as {
      imports: unknown[]; importedBy: unknown[];
    };
    expect(result.imports).toHaveLength(1);
    expect(result.importedBy).toHaveLength(1);
  });

  it('returns error when file not found in dependency graph', async () => {
    await mockDepGraph();
    const result = await handleGetFileDependencies('/proj', 'src/nonexistent.ts') as { error: string };
    expect(result.error).toContain('File not found in dependency graph');
  });
});

// ============================================================================
// EdgeStore fast paths — handleGetSubgraph + handleAnalyzeImpact
// ============================================================================

describe('handleGetSubgraph — edgeStore fast path', () => {
  let dir: string;
  let store: EdgeStore;

  // Graph: entry → middle → leaf (downstream chain)
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-subgraph-test-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([
      makeNode({ id: 'src/a.ts::entry',  fanOut: 1 }),
      makeNode({ id: 'src/b.ts::middle', fanOut: 1 }),
      makeNode({ id: 'src/c.ts::leaf',   fanOut: 0 }),
    ]);
    store.insertEdges([
      makeEdge('src/a.ts::entry',  'src/b.ts::middle'),
      makeEdge('src/b.ts::middle', 'src/c.ts::leaf'),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds seed via searchNodes (indexed) and returns downstream subgraph', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'entry', 'downstream', 2) as Record<string, unknown>;

    const nodes = result.nodes as Array<{ name: string }>;
    expect(nodes.map(n => n.name)).toContain('entry');
    expect(nodes.map(n => n.name)).toContain('middle');
    expect(nodes.map(n => n.name)).toContain('leaf');
  });

  it('subgraph edges connect visited nodes correctly', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'entry', 'downstream', 2) as Record<string, unknown>;

    const edges = result.edges as Array<{ caller: string; callee: string }>;
    expect(edges.some(e => e.caller === 'entry' && e.callee === 'middle')).toBe(true);
    expect(edges.some(e => e.caller === 'middle' && e.callee === 'leaf')).toBe(true);
  });

  it('upstream direction returns callers only', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'leaf', 'upstream', 2) as Record<string, unknown>;

    const nodes = result.nodes as Array<{ name: string }>;
    const names = nodes.map(n => n.name);
    expect(names).toContain('leaf');
    expect(names).toContain('middle');
    expect(names).toContain('entry');
  });

  it('depth limit is respected', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'entry', 'downstream', 1) as Record<string, unknown>;

    const nodes = result.nodes as Array<{ name: string }>;
    const names = nodes.map(n => n.name);
    expect(names).toContain('entry');
    expect(names).toContain('middle');
    expect(names).not.toContain('leaf'); // depth 1 stops at middle
  });

  it('returns error when function name not found', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleGetSubgraph(dir, 'nonexistent', 'downstream', 2) as { error: string };
    expect(result.error).toContain('nonexistent');
  });
});

describe('handleAnalyzeImpact — edgeStore fast path', () => {
  let dir: string;
  let store: EdgeStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-impact-test-'));
    store = EdgeStore.open(join(dir, 'call-graph.db'));
    store.insertNodes([
      makeNode({ id: 'src/a.ts::entry',  fanOut: 2 }),
      makeNode({ id: 'src/b.ts::middle', fanIn: 1, fanOut: 1 }),
      makeNode({ id: 'src/c.ts::leaf',   fanIn: 1, fanOut: 0 }),
    ]);
    store.insertEdges([
      makeEdge('src/a.ts::entry',  'src/b.ts::middle'),
      makeEdge('src/b.ts::middle', 'src/c.ts::leaf'),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('computes downstream blast radius via lazy BFS', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'entry', 2) as Record<string, unknown>;

    const blast = result.blastRadius as { total: number; downstream: number; upstream: number };
    expect(blast.downstream).toBe(2); // middle + leaf
    expect(blast.upstream).toBe(0);   // nothing calls entry
  });

  it('computes upstream chain for a leaf node', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'leaf', 2) as Record<string, unknown>;

    const blast = result.blastRadius as { total: number; upstream: number };
    expect(blast.upstream).toBe(2); // middle + entry call into leaf
  });

  it('returns riskLevel field', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({ edgeStore: store } as never);
    const result = await handleAnalyzeImpact(dir, 'middle', 2) as Record<string, unknown>;
    expect(['low', 'medium', 'high', 'critical']).toContain(result.riskLevel);
  });
});
