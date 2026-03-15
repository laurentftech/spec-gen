import { describe, it, expect } from 'vitest';
import {
  getFileGodFunctions,
  extractSubgraph,
  buildGraphPromptSection,
} from './subgraph-extractor.js';
import type { SerializedCallGraph } from './call-graph.js';

// Minimal call graph fixture:
//   pipeline.ts: run (fanOut=3), helper (fanOut=0)
//   utils.ts:    fmt (fanOut=1)
//
// run → runStage1, runStage2, runStage3
// fmt → escape
const fixture: SerializedCallGraph = {
  nodes: [
    {
      id: 'pipeline.ts::run',
      name: 'run',
      filePath: 'src/pipeline.ts',
      fanIn: 0,
      fanOut: 3,
      isAsync: true,
      language: 'TypeScript',
      className: undefined,
      startIndex: 0,
      endIndex: 500,
    },
    {
      id: 'pipeline.ts::helper',
      name: 'helper',
      filePath: 'src/pipeline.ts',
      fanIn: 1,
      fanOut: 0,
      isAsync: false,
      language: 'TypeScript',
      className: undefined,
      startIndex: 501,
      endIndex: 600,
    },
    {
      id: 'pipeline.ts::runStage1',
      name: 'runStage1',
      filePath: 'src/pipeline.ts',
      fanIn: 1,
      fanOut: 0,
      isAsync: true,
      language: 'TypeScript',
      className: undefined,
      startIndex: 601,
      endIndex: 700,
    },
    {
      id: 'pipeline.ts::runStage2',
      name: 'runStage2',
      filePath: 'src/pipeline.ts',
      fanIn: 1,
      fanOut: 0,
      isAsync: true,
      language: 'TypeScript',
      className: undefined,
      startIndex: 701,
      endIndex: 800,
    },
    {
      id: 'pipeline.ts::runStage3',
      name: 'runStage3',
      filePath: 'src/pipeline.ts',
      fanIn: 1,
      fanOut: 0,
      isAsync: true,
      language: 'TypeScript',
      className: undefined,
      startIndex: 801,
      endIndex: 900,
    },
    {
      id: 'utils.ts::fmt',
      name: 'fmt',
      filePath: 'src/utils.ts',
      fanIn: 0,
      fanOut: 1,
      isAsync: false,
      language: 'TypeScript',
      className: undefined,
      startIndex: 0,
      endIndex: 100,
    },
    {
      id: 'utils.ts::escape',
      name: 'escape',
      filePath: 'src/utils.ts',
      fanIn: 1,
      fanOut: 0,
      isAsync: false,
      language: 'TypeScript',
      className: undefined,
      startIndex: 101,
      endIndex: 200,
    },
  ],
  edges: [
    { callerId: 'pipeline.ts::run', calleeId: 'pipeline.ts::runStage1', calleeName: 'runStage1', confidence: 'name_only' as const },
    { callerId: 'pipeline.ts::run', calleeId: 'pipeline.ts::runStage2', calleeName: 'runStage2', confidence: 'name_only' as const },
    { callerId: 'pipeline.ts::run', calleeId: 'pipeline.ts::runStage3', calleeName: 'runStage3', confidence: 'name_only' as const },
    { callerId: 'utils.ts::fmt', calleeId: 'utils.ts::escape', calleeName: 'escape', confidence: 'name_only' as const },
  ],
  hubFunctions: [],
  entryPoints: [],
  layerViolations: [],
  stats: { totalNodes: 7, totalEdges: 4, avgFanIn: 0.5, avgFanOut: 0.5 },
};

describe('getFileGodFunctions', () => {
  it('returns functions above threshold', () => {
    const gods = getFileGodFunctions(fixture, 'src/pipeline.ts', 3);
    expect(gods.map((n) => n.name)).toContain('run');
  });

  it('excludes functions below threshold', () => {
    const gods = getFileGodFunctions(fixture, 'src/pipeline.ts', 3);
    expect(gods.map((n) => n.name)).not.toContain('helper');
  });

  it('matches by path suffix', () => {
    const gods = getFileGodFunctions(fixture, 'pipeline.ts', 3);
    expect(gods).toHaveLength(1);
  });

  it('returns empty when no god functions', () => {
    expect(getFileGodFunctions(fixture, 'src/utils.ts', 3)).toHaveLength(0);
  });
});

describe('extractSubgraph', () => {
  it('roots on the given function', () => {
    const root = fixture.nodes.find((n) => n.name === 'run')!;
    const sub = extractSubgraph(fixture, root);
    expect(sub.root.name).toBe('run');
  });

  it('includes direct callees', () => {
    const root = fixture.nodes.find((n) => n.name === 'run')!;
    const sub = extractSubgraph(fixture, root);
    const names = sub.nodes.map((n) => n.name);
    expect(names).toContain('runStage1');
    expect(names).toContain('runStage2');
    expect(names).toContain('runStage3');
  });

  it('produces edges for each callee', () => {
    const root = fixture.nodes.find((n) => n.name === 'run')!;
    const sub = extractSubgraph(fixture, root);
    const fromRoot = sub.edges.filter(([from]) => from === 'run');
    expect(fromRoot).toHaveLength(3);
  });
});

describe('buildGraphPromptSection', () => {
  it('returns null when no call graph', () => {
    expect(buildGraphPromptSection(undefined, undefined, 'anything.ts')).toBeNull();
  });

  it('returns null when file has no god functions', () => {
    // utils.ts: fmt has fanOut=1, below default threshold of 8
    expect(buildGraphPromptSection(fixture, undefined, 'src/utils.ts')).toBeNull();
  });

  it('returns a prompt section for god-function files', () => {
    // pipeline.ts: run has fanOut=3, use threshold=3
    // We need to patch threshold — call getFileGodFunctions directly
    const gods = getFileGodFunctions(fixture, 'src/pipeline.ts', 3);
    expect(gods.length).toBeGreaterThan(0);
    // buildGraphPromptSection uses default threshold 8; so override via low-fanout fixture
    const lowFixture: SerializedCallGraph = {
      ...fixture,
      nodes: fixture.nodes.map((n) => (n.name === 'run' ? { ...n, fanOut: 10 } : n)),
    };
    const section = buildGraphPromptSection(lowFixture, undefined, 'src/pipeline.ts');
    expect(section).not.toBeNull();
    expect(section).toContain('[Graph-based analysis');
    expect(section).toContain('run');
  });

  it('includes signatures when provided', () => {
    const lowFixture: SerializedCallGraph = {
      ...fixture,
      nodes: fixture.nodes.map((n) => (n.name === 'run' ? { ...n, fanOut: 10 } : n)),
    };
    const sigs = [
      {
        path: 'src/pipeline.ts',
        language: 'TypeScript',
        entries: [
          {
            kind: 'function' as const,
            name: 'run',
            signature: 'async function run(): Promise<void>',
            docstring: 'Main entry',
          },
        ],
      },
    ];
    const section = buildGraphPromptSection(lowFixture, sigs, 'src/pipeline.ts');
    expect(section).toContain('async function run()');
    expect(section).toContain('Main entry');
  });
});
