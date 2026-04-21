import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scoreFromDepGraph } from './lib/spec-gen-decision-extractor-helpers.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeDepGraph(nodes: any[] = []) {
  return {
    nodes,
    edges: [],
    statistics: { nodeCount: nodes.length, edgeCount: 0 },
  };
}

function makeNode(path: string, inDegree = 0, pageRank = 0.1, score = 0.2) {
  return {
    id: path,
    file: { path, score },
    metrics: { inDegree, outDegree: 0, betweenness: 0, pageRank },
    exports: [],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('scoreFromDepGraph', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-extractor-test-'));
    await mkdir(join(tmpDir, '.spec-gen', 'analysis'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns null when dependency-graph.json is missing', () => {
    const result = scoreFromDepGraph('src/foo.ts', tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when dependency-graph.json is invalid JSON', async () => {
    await writeFile(join(tmpDir, '.spec-gen', 'analysis', 'dependency-graph.json'), 'not json');
    const result = scoreFromDepGraph('src/foo.ts', tmpDir);
    expect(result).toBeNull();
  });

  it('returns null when file is not in the graph', async () => {
    await writeFile(
      join(tmpDir, '.spec-gen', 'analysis', 'dependency-graph.json'),
      JSON.stringify(makeDepGraph([makeNode('src/other.ts')]))
    );
    const result = scoreFromDepGraph('src/foo.ts', tmpDir);
    expect(result).toBeNull();
  });

  it('finds a node by exact path', async () => {
    await writeFile(
      join(tmpDir, '.spec-gen', 'analysis', 'dependency-graph.json'),
      JSON.stringify(makeDepGraph([makeNode('src/foo.ts', 2, 0.3, 0.5)]))
    );
    const result = scoreFromDepGraph('src/foo.ts', tmpDir);
    expect(result).not.toBeNull();
    expect(result!.inDegree).toBe(2);
    expect(result!.pageRank).toBeCloseTo(0.3);
    expect(result!.fileScore).toBeCloseTo(0.5);
  });

  it('finds a node by path suffix', async () => {
    await writeFile(
      join(tmpDir, '.spec-gen', 'analysis', 'dependency-graph.json'),
      JSON.stringify(makeDepGraph([makeNode('/absolute/project/src/foo.ts', 1, 0.2, 0.4)]))
    );
    const result = scoreFromDepGraph('src/foo.ts', tmpDir);
    expect(result).not.toBeNull();
    expect(result!.inDegree).toBe(1);
  });

  it('marks a node as hub when inDegree is high', async () => {
    await writeFile(
      join(tmpDir, '.spec-gen', 'analysis', 'dependency-graph.json'),
      JSON.stringify(makeDepGraph([makeNode('src/hub.ts', 5, 0.1, 0.2)]))
    );
    const result = scoreFromDepGraph('src/hub.ts', tmpDir);
    expect(result!.isHub).toBe(true);
  });

  it('marks a node as hub when pageRank is high', async () => {
    await writeFile(
      join(tmpDir, '.spec-gen', 'analysis', 'dependency-graph.json'),
      JSON.stringify(makeDepGraph([makeNode('src/central.ts', 0, 0.6, 0.2)]))
    );
    const result = scoreFromDepGraph('src/central.ts', tmpDir);
    expect(result!.isHub).toBe(true);
  });

  it('marks a node as hub when fileScore is high', async () => {
    await writeFile(
      join(tmpDir, '.spec-gen', 'analysis', 'dependency-graph.json'),
      JSON.stringify(makeDepGraph([makeNode('src/important.ts', 0, 0.1, 0.8)]))
    );
    const result = scoreFromDepGraph('src/important.ts', tmpDir);
    expect(result!.isHub).toBe(true);
  });

  it('does not mark a low-centrality node as hub', async () => {
    await writeFile(
      join(tmpDir, '.spec-gen', 'analysis', 'dependency-graph.json'),
      JSON.stringify(makeDepGraph([makeNode('src/leaf.ts', 0, 0.05, 0.1)]))
    );
    const result = scoreFromDepGraph('src/leaf.ts', tmpDir);
    expect(result!.isHub).toBe(false);
  });

  it('handles missing metrics fields gracefully', async () => {
    const node = { id: 'src/bare.ts', file: { path: 'src/bare.ts' }, exports: [] };
    await writeFile(
      join(tmpDir, '.spec-gen', 'analysis', 'dependency-graph.json'),
      JSON.stringify(makeDepGraph([node]))
    );
    const result = scoreFromDepGraph('src/bare.ts', tmpDir);
    expect(result).not.toBeNull();
    expect(result!.inDegree).toBe(0);
    expect(result!.pageRank).toBe(0);
    expect(result!.fileScore).toBe(0);
    expect(result!.isHub).toBe(false);
  });
});
