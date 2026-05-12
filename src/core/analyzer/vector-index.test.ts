import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorIndex } from './vector-index.js';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';
import type { EmbeddingService } from './embedding-service.js';

// ============================================================================
// FIXTURES
// ============================================================================

function makeNode(overrides: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id: 'src/auth.ts::authenticate',
    name: 'authenticate',
    filePath: 'src/auth.ts',
    language: 'TypeScript',
    isAsync: true,
    startIndex: 0,
    endIndex: 100,
    fanIn: 3,
    fanOut: 2,
    ...overrides,
  };
}

const SAMPLE_NODES: FunctionNode[] = [
  makeNode({
    id: 'src/auth.ts::authenticate',
    name: 'authenticate',
    filePath: 'src/auth.ts',
    fanIn: 5,
    fanOut: 2,
  }),
  makeNode({
    id: 'src/users.ts::getUser',
    name: 'getUser',
    filePath: 'src/users.ts',
    fanIn: 2,
    fanOut: 1,
  }),
  makeNode({
    id: 'src/db.ts::connect',
    name: 'connect',
    filePath: 'src/db.ts',
    language: 'TypeScript',
    fanIn: 10,
    fanOut: 0,
  }),
];

const SAMPLE_SIGNATURES: FileSignatureMap[] = [
  {
    path: 'src/auth.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'authenticate',
        signature: 'async function authenticate(token: string): Promise<User>',
        docstring: 'Authenticate a user via JWT token',
      },
    ],
  },
  {
    path: 'src/users.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'getUser',
        signature: 'async function getUser(id: string): Promise<User | null>',
        docstring: 'Fetch a user by ID',
      },
    ],
  },
];

// ============================================================================
// MOCK EMBEDDING SERVICE
// ============================================================================

const DIM = 8;

function makeVector(seed: number): number[] {
  return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) * 0.1);
}

function makeMockEmbedSvc(
  strategy: 'fixed' | 'query-similarity' = 'fixed'
): EmbeddingService {
  let callCount = 0;
  return {
    embed: vi.fn().mockImplementation(async (texts: string[]) => {
      if (strategy === 'query-similarity') {
        // Make the first text's vector similar to a "query about authentication"
        return texts.map((t, i) => {
          const seed = t.toLowerCase().includes('auth') ? 0 : (callCount + i + 5) % 10;
          callCount++;
          return makeVector(seed);
        });
      }
      return texts.map((_, i) => makeVector(callCount + i));
    }),
  } as unknown as EmbeddingService;
}

// ============================================================================
// TESTS
// ============================================================================

describe('VectorIndex', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-vector-test-'));
  });

  // Clean up after each test
  // (not strictly needed since tests use unique tmpDirs, but good practice)

  describe('exists()', () => {
    it('returns false when no index has been built', () => {
      expect(VectorIndex.exists(tmpDir)).toBe(false);
    });

    it('returns true after build()', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(
        tmpDir,
        SAMPLE_NODES,
        SAMPLE_SIGNATURES,
        new Set(['src/auth.ts::authenticate']),
        new Set(),
        embedSvc
      );
      expect(VectorIndex.exists(tmpDir)).toBe(true);
    });
  });

  describe('build()', () => {
    it('creates the vector-index folder', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);
      expect(VectorIndex.exists(tmpDir)).toBe(true);
    });

    it('calls embed once with all texts concatenated', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);
      expect(embedSvc.embed).toHaveBeenCalledTimes(1);
      const texts = (embedSvc.embed as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
      expect(texts).toHaveLength(SAMPLE_NODES.length);
    });

    it('throws when nodes array is empty', async () => {
      const embedSvc = makeMockEmbedSvc();
      await expect(
        VectorIndex.build(tmpDir, [], SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc)
      ).rejects.toThrow('No functions to index');
    });

    it('marks hub functions correctly', async () => {
      const hubIds = new Set(['src/auth.ts::authenticate']);
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, hubIds, new Set(), embedSvc);

      // Search and verify hub flag
      const results = await VectorIndex.search(tmpDir, 'authenticate', embedSvc, { limit: 10 });
      const authResult = results.find(r => r.record.name === 'authenticate');
      expect(authResult?.record.isHub).toBe(true);

      const getUserResult = results.find(r => r.record.name === 'getUser');
      expect(getUserResult?.record.isHub).toBe(false);
    });

    it('overwrites existing index on second build', async () => {
      const embedSvc = makeMockEmbedSvc();
      // First build
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);
      // Second build (overwrite)
      await expect(
        VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc)
      ).resolves.not.toThrow();
    });
  });

  describe('search()', () => {
    it('returns up to limit results', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'any query', embedSvc, { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('each result has a score field', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'query', embedSvc, { limit: 10 });
      for (const r of results) {
        expect(typeof r.score).toBe('number');
      }
    });

    it('result records do not include the vector field', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'query', embedSvc, { limit: 10 });
      for (const r of results) {
        expect((r.record as Record<string, unknown>)['vector']).toBeUndefined();
      }
    });

    it('filters by language', async () => {
      const mixedNodes: FunctionNode[] = [
        ...SAMPLE_NODES,
        makeNode({
          id: 'src/main.py::run',
          name: 'run',
          filePath: 'src/main.py',
          language: 'Python',
          fanIn: 0,
          fanOut: 1,
        }),
      ];
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, mixedNodes, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'query', embedSvc, {
        limit: 10,
        language: 'Python',
      });
      for (const r of results) {
        expect(r.record.language).toBe('Python');
      }
    });

    it('filters by minFanIn', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      // Only src/db.ts::connect has fanIn=10, src/auth.ts::authenticate has fanIn=5
      const results = await VectorIndex.search(tmpDir, 'query', embedSvc, {
        limit: 10,
        minFanIn: 6,
      });
      for (const r of results) {
        expect(r.record.fanIn).toBeGreaterThanOrEqual(6);
      }
    });

    it('includes signature and docstring in records when available', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'authenticate', embedSvc, { limit: 10 });
      const authResult = results.find(r => r.record.name === 'authenticate');
      expect(authResult?.record.signature).toContain('authenticate');
      expect(authResult?.record.docstring).toContain('JWT');
    });

    it('returns empty array when minFanIn filters out everything', async () => {
      const embedSvc = makeMockEmbedSvc();
      await VectorIndex.build(tmpDir, SAMPLE_NODES, SAMPLE_SIGNATURES, new Set(), new Set(), embedSvc);

      const results = await VectorIndex.search(tmpDir, 'query', embedSvc, {
        limit: 10,
        minFanIn: 9999,
      });
      expect(results).toHaveLength(0);
    });
  });
});
