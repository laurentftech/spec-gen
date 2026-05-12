/**
 * Tests for handleOrient
 *
 * Strategy:
 *  - Mock validateDirectory to skip filesystem checks.
 *  - Mock VectorIndex / EmbeddingService / SpecVectorIndex via vi.mock so dynamic
 *    imports resolve to lightweight stubs.
 *  - Mock utils helpers (loadMappingIndex, readCachedContext, …).
 *  - Mock semantic helpers (classifyRole, deriveStrategy, …) with simple return values.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Static mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (dir: string) => dir),
  loadMappingIndex: vi.fn(async () => null),
  specsForFile: vi.fn(() => []),
  functionsForDomain: vi.fn(() => []),
  readCachedContext: vi.fn(async () => null),
  isCacheFresh: vi.fn(async () => false),
}));

vi.mock('../config-manager.js', () => ({
  readSpecGenConfig: vi.fn(async () => null),
}));

vi.mock('./semantic.js', () => ({
  classifyRole: vi.fn(() => 'orchestrator'),
  deriveStrategy: vi.fn(() => 'wrap'),
  compositeScore: vi.fn((score: number) => score),
  buildReason: vi.fn(() => 'test reason'),
}));

vi.mock('../../analyzer/vector-index.js', () => ({
  VectorIndex: {
    exists: vi.fn(() => false),
    search: vi.fn(async () => []),
  },
}));

vi.mock('../../analyzer/embedding-service.js', () => ({
  EmbeddingService: {
    fromEnv: vi.fn(() => { throw new Error('no env'); }),
    fromConfig: vi.fn(() => null),
  },
}));

vi.mock('../../analyzer/spec-vector-index.js', () => ({
  SpecVectorIndex: {
    exists: vi.fn(() => false),
    search: vi.fn(async () => []),
  },
}));

vi.mock('../../decisions/store.js', () => ({
  loadDecisionStore: vi.fn(async () => ({
    version: '1',
    sessionId: 'test-session',
    updatedAt: '2026-01-01T00:00:00.000Z',
    decisions: [],
  })),
  INACTIVE_STATUSES: new Set(['rejected', 'synced', 'phantom']),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { handleOrient } from './orient.js';
import { VectorIndex } from '../../analyzer/vector-index.js';
import { EmbeddingService } from '../../analyzer/embedding-service.js';
import { SpecVectorIndex } from '../../analyzer/spec-vector-index.js';
import { loadMappingIndex, specsForFile, functionsForDomain, readCachedContext } from './utils.js';
import { readSpecGenConfig } from '../config-manager.js';
import { loadDecisionStore } from '../../decisions/store.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSearchResult(overrides: Partial<{
  id: string; name: string; filePath: string; fanIn: number; fanOut: number;
}> = {}) {
  return {
    score: 0.2,
    record: {
      id: overrides.id ?? 'src/foo.ts::doFoo',
      name: overrides.name ?? 'doFoo',
      filePath: overrides.filePath ?? 'src/foo.ts',
      signature: 'function doFoo(): void',
      docstring: 'Does foo',
      language: 'TypeScript',
      fanIn: overrides.fanIn ?? 2,
      fanOut: overrides.fanOut ?? 3,
      isHub: false,
      isEntryPoint: false,
      text: '',
      className: '',
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleOrient', () => {
  beforeEach(() => {
    vi.mocked(VectorIndex.exists).mockReturnValue(false);
    vi.mocked(VectorIndex.search).mockResolvedValue([]);
    vi.mocked(SpecVectorIndex.exists).mockReturnValue(false);
    vi.mocked(SpecVectorIndex.search).mockResolvedValue([]);
    vi.mocked(loadMappingIndex).mockResolvedValue(null);
    vi.mocked(readCachedContext).mockResolvedValue(null);
    vi.mocked(specsForFile).mockReturnValue([]);
    vi.mocked(functionsForDomain).mockReturnValue([]);
    vi.mocked(readSpecGenConfig).mockResolvedValue(null);
    vi.mocked(EmbeddingService.fromEnv).mockImplementation(() => { throw new Error('no env'); });
    vi.mocked(EmbeddingService.fromConfig).mockReturnValue(null);
    vi.mocked(loadDecisionStore).mockResolvedValue({
      version: '1',
      sessionId: 'test-session',
      updatedAt: '2026-01-01T00:00:00.000Z',
      decisions: [],
    });
  });

  it('returns error when no code index exists', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(false);
    const result = await handleOrient('/tmp/proj', 'find auth handler') as Record<string, unknown>;
    expect(result.error).toContain('No analysis found');
    expect(result.hint).toBeDefined();
  });

  it('returns orient structure when code index exists and search returns results', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ name: 'handleAuth', filePath: 'src/auth.ts' }),
      makeSearchResult({ name: 'verifyToken', filePath: 'src/auth.ts' }),
    ]);

    const result = await handleOrient('/tmp/proj', 'auth handler', 2) as Record<string, unknown>;

    expect(result.task).toBe('auth handler');
    expect(result.searchMode).toBe('bm25_fallback'); // EmbeddingService.fromEnv throws → bm25
    expect(Array.isArray(result.relevantFiles)).toBe(true);
    expect(Array.isArray(result.relevantFunctions)).toBe(true);
    expect(Array.isArray(result.callPaths)).toBe(true);
    expect(Array.isArray(result.insertionPoints)).toBe(true);
    expect(Array.isArray(result.nextSteps)).toBe(true);
    expect((result.relevantFunctions as unknown[]).length).toBeGreaterThan(0);
  });

  it('preserves raw score (higher = better) without inverting via 1 - score', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ name: 'topResult', filePath: 'src/top.ts' }),
    ]);

    const result = await handleOrient('/tmp/proj', 'test task') as Record<string, unknown>;
    const fns = result.relevantFunctions as Array<{ score: number; name: string }>;
    expect(fns.length).toBe(1);
    // Raw score from mock is 0.2 — should be preserved, NOT inverted to 0.8
    expect(fns[0].score).toBe(0.2);
  });

  it('returns empty collections when search returns no results', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([]);

    const result = await handleOrient('/tmp/proj', 'unknown task') as Record<string, unknown>;

    expect(result.relevantFunctions).toEqual([]);
    expect(result.relevantFiles).toEqual([]);
    expect(result.callPaths).toEqual([]);
    expect(result.insertionPoints).toEqual([]);
    expect(Array.isArray(result.nextSteps)).toBe(true);
  });

  it('uses embed service from config when env service is unavailable', async () => {
    vi.mocked(EmbeddingService.fromConfig).mockReturnValue({ model: 'config-model' } as never);
    vi.mocked(readSpecGenConfig).mockResolvedValue({ version: '1.0' } as never); // non-null cfg
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);

    const result = await handleOrient('/tmp/proj', 'task') as Record<string, unknown>;

    // When fromConfig returns a service, searchMode should be 'hybrid' (not bm25_fallback)
    expect(result.searchMode).toBe('hybrid');
    expect(result.note).toBeUndefined();
  });

  it('includes specLinkedFunctions from cross-graph spec traversal', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ id: 'src/auth.ts::login', name: 'login', filePath: 'src/auth.ts' }),
    ]);
    vi.mocked(loadMappingIndex).mockResolvedValue({ domains: {}, files: {} } as never);
    // Seed function has linkedSpecs in a domain
    vi.mocked(specsForFile).mockReturnValue([
      { requirement: 'Login', domain: 'auth', specFile: 'openspec/specs/auth/spec.md' },
    ]);
    // functionsForDomain returns a peer in a DIFFERENT file (not in seed file set)
    vi.mocked(functionsForDomain).mockReturnValue([
      { name: 'logout', file: 'src/session.ts', line: 0, kind: 'function', confidence: 'high', requirement: 'Logout' },
    ]);

    const result = await handleOrient('/tmp/proj', 'login task') as Record<string, unknown>;

    expect(result.specLinkedFunctions).toBeDefined();
    const linked = result.specLinkedFunctions as Array<{ name: string; filePath: string }>;
    expect(linked.some(f => f.name === 'logout')).toBe(true);
  });

  it('includes bm25_fallback note when embedding service is unavailable', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);

    const result = await handleOrient('/tmp/proj', 'task') as Record<string, unknown>;

    expect(result.searchMode).toBe('bm25_fallback');
    expect(typeof result.note).toBe('string');
    expect(result.note as string).toContain('Embedding server unavailable');
  });

  it('includes specDomains when mapping index provides file-to-spec data', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ filePath: 'src/auth.ts' }),
    ]);
    vi.mocked(loadMappingIndex).mockResolvedValue({ domains: {}, files: {} } as never);
    vi.mocked(specsForFile).mockReturnValue([
      { requirement: 'Auth flow', domain: 'auth', specFile: 'openspec/specs/auth/spec.md' },
    ]);

    const result = await handleOrient('/tmp/proj', 'auth') as Record<string, unknown>;

    expect(Array.isArray(result.specDomains)).toBe(true);
    const domains = result.specDomains as Array<{ domain: string }>;
    expect(domains.some(d => d.domain === 'auth')).toBe(true);
  });

  it('includes call paths derived from call graph context', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    const searchResult = makeSearchResult({ id: 'src/foo.ts::doFoo', name: 'doFoo', filePath: 'src/foo.ts' });
    vi.mocked(VectorIndex.search).mockResolvedValue([searchResult]);
    vi.mocked(readCachedContext).mockResolvedValue({
      callGraph: {
        nodes: [
          { id: 'src/foo.ts::doFoo', name: 'doFoo', filePath: 'src/foo.ts', fanIn: 1, fanOut: 1, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 100 },
          { id: 'src/bar.ts::doBar', name: 'doBar', filePath: 'src/bar.ts', fanIn: 0, fanOut: 0, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 50 },
        ],
        edges: [
          { callerId: 'src/foo.ts::doFoo', calleeId: 'src/bar.ts::doBar', calleeName: 'doBar', confidence: 'name_only' },
        ],
        classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
        stats: { totalNodes: 2, totalEdges: 1, avgFanIn: 0.5, avgFanOut: 0.5 },
      },
      edgeStore: {
        getCallers: (id: string) => id === 'src/bar.ts::doBar'
          ? [{ callerId: 'src/foo.ts::doFoo', calleeId: 'src/bar.ts::doBar', calleeName: 'doBar', confidence: 'name_only' }]
          : [],
        getCallees: (id: string) => id === 'src/foo.ts::doFoo'
          ? [{ callerId: 'src/foo.ts::doFoo', calleeId: 'src/bar.ts::doBar', calleeName: 'doBar', confidence: 'name_only' }]
          : [],
        getNode: (id: string) => id === 'src/bar.ts::doBar'
          ? { id: 'src/bar.ts::doBar', name: 'doBar', filePath: 'src/bar.ts', fanIn: 0, fanOut: 0, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 50 }
          : null,
      },
    } as never);

    const result = await handleOrient('/tmp/proj', 'foo task') as Record<string, unknown>;
    const callPaths = result.callPaths as Array<{ function: string; callees: unknown[] }>;

    expect(callPaths.length).toBeGreaterThan(0);
    const fooPath = callPaths.find(p => p.function === 'doFoo');
    expect(fooPath).toBeDefined();
    expect(fooPath!.callees.length).toBeGreaterThan(0);
  });

  it('includes matchingSpecs when spec index and embed service are available', async () => {
    vi.mocked(EmbeddingService.fromEnv).mockReturnValue({ model: 'test' } as never);
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(SpecVectorIndex.exists).mockReturnValue(true);
    vi.mocked(SpecVectorIndex.search).mockResolvedValue([{
      score: 0.1,
      record: { domain: 'auth', section: '## Auth Flow', title: 'Authentication', text: 'Auth text here', id: 'auth::1' },
    } as never]);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);

    const result = await handleOrient('/tmp/proj', 'auth') as Record<string, unknown>;

    expect(result.matchingSpecs).toBeDefined();
    const specs = result.matchingSpecs as Array<{ domain: string }>;
    expect(specs[0].domain).toBe('auth');
  });

  it('filters out external synthetic nodes from relevantFunctions', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([
      makeSearchResult({ name: 'realFn', filePath: 'src/real.ts' }),
      { score: 0.5, record: { ...makeSearchResult().record, id: 'external::fetch', name: 'fetch', filePath: 'external' } },
      { score: 0.4, record: { ...makeSearchResult().record, id: 'external::https.request', name: 'https.request', filePath: 'src/real.ts' } },
    ]);

    const result = await handleOrient('/tmp/proj', 'fetch task') as Record<string, unknown>;
    const fns = result.relevantFunctions as Array<{ name: string; filePath: string }>;

    expect(fns.some(f => f.filePath === 'external')).toBe(false);
    expect(fns.some(f => f.name === 'fetch')).toBe(false);
    // The node with id starting with 'external::' is also filtered even if filePath differs
    expect(fns.some(f => f.name === 'https.request')).toBe(false);
  });

  it('includes pendingDecisions when active decisions exist', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);
    vi.mocked(loadDecisionStore).mockResolvedValue({
      version: '1',
      sessionId: 'test-session',
      updatedAt: '2026-01-01T00:00:00.000Z',
      decisions: [
        {
          id: 'abc12345',
          status: 'approved',
          title: 'Use SQLite',
          rationale: 'JSON too big',
          consequences: '',
          proposedRequirement: null,
          affectedDomains: ['services'],
          affectedFiles: [],
          sessionId: 'test-session',
          recordedAt: '2026-01-01T00:00:00.000Z',
          confidence: 'medium',
          syncedToSpecs: [],
        },
        {
          id: 'def67890',
          status: 'synced', // excluded — synced decisions are not active
          title: 'Already synced',
          rationale: 'Done',
          consequences: '',
          proposedRequirement: null,
          affectedDomains: [],
          affectedFiles: [],
          sessionId: 'test-session',
          recordedAt: '2026-01-01T00:00:00.000Z',
          confidence: 'medium',
          syncedToSpecs: ['services'],
        },
      ],
    });

    const result = await handleOrient('/tmp/proj', 'task') as Record<string, unknown>;

    expect(result.pendingDecisions).toBeDefined();
    const decisions = result.pendingDecisions as Array<{ id: string; status: string }>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].id).toBe('abc12345');
    expect(decisions[0].status).toBe('approved');
  });

  it('omits pendingDecisions when all decisions are synced or rejected', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    vi.mocked(VectorIndex.search).mockResolvedValue([makeSearchResult()]);
    vi.mocked(loadDecisionStore).mockResolvedValue({
      version: '1',
      sessionId: 'test-session',
      updatedAt: '2026-01-01T00:00:00.000Z',
      decisions: [
        {
          id: 'aaa11111',
          status: 'synced',
          title: 'Done',
          rationale: 'r',
          consequences: '',
          proposedRequirement: null,
          affectedDomains: [],
          affectedFiles: [],
          sessionId: 's',
          recordedAt: '2026-01-01T00:00:00.000Z',
          confidence: 'low',
          syncedToSpecs: [],
        },
        {
          id: 'bbb22222',
          status: 'rejected',
          title: 'Bad',
          rationale: 'r',
          consequences: '',
          proposedRequirement: null,
          affectedDomains: [],
          affectedFiles: [],
          sessionId: 's',
          recordedAt: '2026-01-01T00:00:00.000Z',
          confidence: 'low',
          syncedToSpecs: [],
        },
      ],
    });

    const result = await handleOrient('/tmp/proj', 'task') as Record<string, unknown>;

    expect(result.pendingDecisions).toBeUndefined();
  });

  it('omits external callee neighbours from call paths', async () => {
    vi.mocked(VectorIndex.exists).mockReturnValue(true);
    const searchResult = makeSearchResult({ id: 'src/foo.ts::doFoo', name: 'doFoo', filePath: 'src/foo.ts' });
    vi.mocked(VectorIndex.search).mockResolvedValue([searchResult]);
    vi.mocked(readCachedContext).mockResolvedValue({
      callGraph: { nodes: [], edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [], stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 } },
      edgeStore: {
        getCallers: () => [],
        getCallees: () => [
          { callerId: 'src/foo.ts::doFoo', calleeId: 'external::fetch', calleeName: 'fetch', confidence: 'name_only' },
          { callerId: 'src/foo.ts::doFoo', calleeId: 'src/bar.ts::doBar', calleeName: 'doBar', confidence: 'exact' },
        ],
        getNode: (id: string) => {
          if (id === 'external::fetch') return { id, name: 'fetch', filePath: 'external', fanIn: 0, fanOut: 0, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 0, isExternal: true };
          if (id === 'src/bar.ts::doBar') return { id, name: 'doBar', filePath: 'src/bar.ts', fanIn: 0, fanOut: 0, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 50 };
          return null;
        },
      },
    } as never);

    const result = await handleOrient('/tmp/proj', 'task') as Record<string, unknown>;
    const callPaths = result.callPaths as Array<{ function: string; callees: Array<{ name: string }> }>;
    const fooPaths = callPaths.find(p => p.function === 'doFoo');

    expect(fooPaths).toBeDefined();
    // External node (fetch) must be filtered out; internal doBar kept
    expect(fooPaths!.callees.some(c => c.name === 'fetch')).toBe(false);
    expect(fooPaths!.callees.some(c => c.name === 'doBar')).toBe(true);
  });
});
