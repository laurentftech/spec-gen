/**
 * Tests for graph.ts pure utility functions:
 * buildAdjacency, bfs, computeRiskScore, recommendStrategy, nodeToSummary
 */

import { describe, it, expect } from 'vitest';
import {
  buildAdjacency,
  bfs,
  computeRiskScore,
  recommendStrategy,
  nodeToSummary,
} from './graph.js';
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
