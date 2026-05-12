/**
 * MCP handler tests — analysis.ts
 *
 * Tests the read-from-cache / static-transform handlers without running the
 * heavy analysis pipeline or making real LLM calls.
 *
 * Strategy:
 *  - Mock validateDirectory to return the temp dir directly.
 *  - Write real JSON fixture files to a temp dir so readFile / stat work
 *    against the same code path used in production.
 *  - Mock runAnalysis (used by handleAnalyzeCodebase) to avoid executing the
 *    full analysis pipeline in unit tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_MAPPING,
  ARTIFACT_ROUTE_INVENTORY,
  ARTIFACT_MIDDLEWARE_INVENTORY,
  ARTIFACT_SCHEMA_INVENTORY,
  ARTIFACT_UI_INVENTORY,
  ARTIFACT_ENV_INVENTORY,
  ARTIFACT_EXTERNAL_PACKAGES,
} from '../../../constants.js';

// ============================================================================
// MODULE MOCKS
// ============================================================================

vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
  return {
    ...actual,
    validateDirectory: vi.fn(async (dir: string) => dir),
    readCachedContext: vi.fn(async () => null),
    isCacheFresh: vi.fn(async () => false),
  };
});

vi.mock('../../../cli/commands/analyze.js', () => ({
  runAnalysis: vi.fn(),
}));

// ============================================================================
// HELPERS
// ============================================================================

async function createTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'openlore-analysis-test-'));
}

async function writeAnalysisFile(rootPath: string, filename: string, content: unknown): Promise<void> {
  const dir = join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), JSON.stringify(content), 'utf-8');
}

function makeMinimalDepGraph() {
  return {
    nodes: [], edges: [], clusters: [], structuralClusters: [], cycles: [],
    rankings: { byImportance: [], byConnectivity: [], clusterCenters: [], leafNodes: [], bridgeNodes: [], orphanNodes: [] },
    statistics: { nodeCount: 5, edgeCount: 3, importEdgeCount: 2, httpEdgeCount: 1, avgDegree: 1, density: 0.1, clusterCount: 0, structuralClusterCount: 0, cycleCount: 0 },
  };
}

function makeMinimalLLMContext() {
  return {
    phase1_survey: { purpose: 'survey', files: [], estimatedTokens: 0 },
    phase2_deep: { purpose: 'deep', files: [], totalTokens: 0 },
    phase3_validation: { purpose: 'validation', files: [], totalTokens: 0 },
  };
}

// ============================================================================
// handleGetArchitectureOverview
// ============================================================================

describe('handleGetArchitectureOverview', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
    readCachedContext.mockResolvedValue(null);
  });

  it('returns error when no dep graph and no cached context', async () => {
    // no files written → readFile will throw ENOENT, readCachedContext returns null
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('returns overview when dep graph exists (no ctx)', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_DEPENDENCY_GRAPH, makeMinimalDepGraph());
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as Record<string, unknown>;
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('clusters');
    expect(result).toHaveProperty('globalEntryPoints');
    expect(result).toHaveProperty('criticalHubs');
  });

  it('returns overview when only cached context exists (no dep graph)', async () => {
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as Record<string, unknown>;
    expect(result).toHaveProperty('summary');
  });

  it('summary totalFiles matches dep graph nodeCount', async () => {
    const graph = makeMinimalDepGraph();
    graph.statistics.nodeCount = 42;
    await writeAnalysisFile(tmpDir, ARTIFACT_DEPENDENCY_GRAPH, graph);
    const { handleGetArchitectureOverview } = await import('./analysis.js');
    const result = await handleGetArchitectureOverview(tmpDir) as { summary: { totalFiles: number } };
    expect(result.summary.totalFiles).toBe(42);
  });
});

// ============================================================================
// handleGetRefactorReport
// ============================================================================

describe('handleGetRefactorReport', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error when no cached context', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleGetRefactorReport } = await import('./analysis.js');
    const result = await handleGetRefactorReport(tmpDir) as { error: string };
    expect(result.error).toContain('No analysis found');
  });

  it('returns error when cached context has no callGraph', async () => {
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleGetRefactorReport } = await import('./analysis.js');
    const result = await handleGetRefactorReport(tmpDir) as { error: string };
    expect(result.error).toContain('Call graph not available');
  });

  it('returns refactor report when callGraph is present', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      callGraph: {
        nodes: [], edges: [], entryPoints: [], hubFunctions: [], layerViolations: [],
        stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
      },
    });
    const { handleGetRefactorReport } = await import('./analysis.js');
    const result = await handleGetRefactorReport(tmpDir) as Record<string, unknown>;
    // analyzeForRefactoring returns an object with a priorities array
    expect(result).toHaveProperty('priorities');
    expect(Array.isArray(result.priorities)).toBe(true);
  });
});

// ============================================================================
// handleGetDuplicateReport
// ============================================================================

describe('handleGetDuplicateReport', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  it('returns error when duplicates.json does not exist', async () => {
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as { error: string };
    expect(result.error).toContain('No duplicate report found');
  });

  it('returns error when duplicates.json is malformed JSON', async () => {
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'duplicates.json'), 'not-json', 'utf-8');
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as { error: string };
    expect(result.error).toContain('corrupted');
  });

  it('returns parsed duplicates report', async () => {
    const payload = { groups: [{ files: ['a.ts', 'b.ts'], similarity: 0.9 }] };
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'duplicates.json'), JSON.stringify(payload), 'utf-8');
    const { handleGetDuplicateReport } = await import('./analysis.js');
    const result = await handleGetDuplicateReport(tmpDir) as typeof payload;
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].similarity).toBe(0.9);
  });
});

// ============================================================================
// handleGetSignatures
// ============================================================================

describe('handleGetSignatures', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error message when no cached context', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir);
    expect(result).toContain('No analysis found');
  });

  it('returns error message when context has no signatures', async () => {
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir);
    expect(result).toContain('No signatures available');
  });

  it('returns formatted signatures when available', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      signatures: [
        { path: 'src/auth.ts', entries: [{ kind: 'function', name: 'login', signature: 'login(username: string): Promise<User>' }] },
      ],
    });
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('filters signatures by filePattern', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      signatures: [
        { path: 'src/auth.ts', entries: [{ kind: 'function', name: 'login', signature: 'login(): void' }] },
        { path: 'src/user.ts', entries: [{ kind: 'function', name: 'getUser', signature: 'getUser(): void' }] },
      ],
    });
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir, 'auth');
    // Should only include auth.ts content, not user.ts
    expect(result).toContain('auth');
    // login function appears in auth.ts
    expect(result).toContain('login');
  });

  it('returns no-match message when filePattern matches nothing', async () => {
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      signatures: [
        { path: 'src/auth.ts', entries: [] },
      ],
    });
    const { handleGetSignatures } = await import('./analysis.js');
    const result = await handleGetSignatures(tmpDir, 'nonexistent');
    expect(result).toContain('No files matching');
  });
});

// ============================================================================
// handleGetMapping
// ============================================================================

describe('handleGetMapping', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  const sampleMapping = {
    generatedAt: '2026-03-12T00:00:00.000Z',
    stats: { totalFunctions: 10, mappedFunctions: 8, orphanFunctions: 2, totalRequirements: 5, coveredRequirements: 5 },
    mappings: [
      { domain: 'auth', requirementId: 'REQ-1', functions: ['login'], coverage: 'full' },
      { domain: 'user', requirementId: 'REQ-2', functions: ['getUser'], coverage: 'partial' },
    ],
    orphanFunctions: [
      { file: 'src/util.ts', name: 'internalHelper' },
      { file: 'src/auth.ts', name: 'hashPassword' },
    ],
  };

  it('returns error when mapping.json does not exist', async () => {
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir) as { error: string };
    expect(result.error).toContain('No mapping found');
  });

  it('returns full mapping when no filters', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_MAPPING, sampleMapping);
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir) as typeof sampleMapping;
    expect(result.mappings).toHaveLength(2);
    expect(result.orphanFunctions).toHaveLength(2);
  });

  it('filters mappings by domain', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_MAPPING, sampleMapping);
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir, 'auth') as { mappings: unknown[]; orphanFunctions: unknown[] };
    expect(result.mappings).toHaveLength(1);
    // When domain is filtered, orphanFunctions is empty
    expect(result.orphanFunctions).toHaveLength(0);
  });

  it('returns only orphans when orphansOnly is true', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_MAPPING, sampleMapping);
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir, undefined, true) as { orphanFunctions: unknown[] };
    expect(result.orphanFunctions).toHaveLength(2);
    expect(result).not.toHaveProperty('mappings');
  });

  it('filters orphans by domain when orphansOnly and domain are set', async () => {
    await writeAnalysisFile(tmpDir, ARTIFACT_MAPPING, sampleMapping);
    const { handleGetMapping } = await import('./analysis.js');
    const result = await handleGetMapping(tmpDir, 'auth', true) as { orphanFunctions: Array<{ file: string }> };
    // Only the auth.ts orphan should be included
    expect(result.orphanFunctions.every((f) => f.file.includes('auth'))).toBe(true);
  });
});

// ============================================================================
// handleGetFunctionSkeleton
// ============================================================================

describe('handleGetFunctionSkeleton', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  it('returns error when file does not exist', async () => {
    const { handleGetFunctionSkeleton } = await import('./analysis.js');
    const result = await handleGetFunctionSkeleton(tmpDir, 'nonexistent.ts') as { error: string };
    expect(result.error).toContain('File not found');
  });

  it('returns skeleton metadata for an existing TypeScript file', async () => {
    const src = `
// This is a comment
export function add(a: number, b: number): number {
  // implementation
  const x = a + b;
  return x;
}
`.trim();
    await writeFile(join(tmpDir, 'add.ts'), src, 'utf-8');

    const { handleGetFunctionSkeleton } = await import('./analysis.js');
    const result = await handleGetFunctionSkeleton(tmpDir, 'add.ts') as {
      filePath: string;
      language: string;
      originalLines: number;
      skeletonLines: number;
      reductionPct: number;
      worthIncluding: boolean;
      skeleton: string;
    };

    expect(result.filePath).toBe('add.ts');
    expect(result.language).toBe('TypeScript');
    expect(result.originalLines).toBeGreaterThan(0);
    expect(result.skeleton).toBeDefined();
    expect(typeof result.reductionPct).toBe('number');
    expect(typeof result.worthIncluding).toBe('boolean');
  });

  it('returns originalLines and skeletonLines as positive integers', async () => {
    await writeFile(join(tmpDir, 'sample.ts'), 'export const x = 1;\n', 'utf-8');
    const { handleGetFunctionSkeleton } = await import('./analysis.js');
    const result = await handleGetFunctionSkeleton(tmpDir, 'sample.ts') as { originalLines: number; skeletonLines: number };
    expect(Number.isInteger(result.originalLines)).toBe(true);
    expect(Number.isInteger(result.skeletonLines)).toBe(true);
    expect(result.originalLines).toBeGreaterThan(0);
    expect(result.skeletonLines).toBeGreaterThan(0);
  });
});

// ============================================================================
// handleAnalyzeCodebase — cached path only
// ============================================================================

describe('handleAnalyzeCodebase (cached path)', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;
  let isCacheFresh: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    readCachedContext = vi.mocked(utils.readCachedContext);
    isCacheFresh = vi.mocked(utils.isCacheFresh);
  });

  it('returns cached result when cache is fresh and has context', async () => {
    isCacheFresh.mockResolvedValue(true);
    readCachedContext.mockResolvedValue({
      ...makeMinimalLLMContext(),
      callGraph: {
        nodes: [], edges: [], entryPoints: [], hubFunctions: [], layerViolations: [],
        stats: { totalNodes: 3, totalEdges: 2, avgFanIn: 0.5, avgFanOut: 0.7 },
      },
    });
    const { handleAnalyzeCodebase } = await import('./analysis.js');
    const result = await handleAnalyzeCodebase(tmpDir, false) as { cached: boolean; callGraph: Record<string, unknown> };
    expect(result.cached).toBe(true);
    expect(result.callGraph?.totalNodes).toBe(3);
  });

  it('returns cached: true with null callGraph when cached context has no callGraph', async () => {
    isCacheFresh.mockResolvedValue(true);
    readCachedContext.mockResolvedValue(makeMinimalLLMContext());
    const { handleAnalyzeCodebase } = await import('./analysis.js');
    const result = await handleAnalyzeCodebase(tmpDir, false) as { cached: boolean; callGraph: null };
    expect(result.cached).toBe(true);
    expect(result.callGraph).toBeNull();
  });

  it('bypasses cache when force=true', async () => {
    isCacheFresh.mockResolvedValue(true);
    const { runAnalysis } = await import('../../../cli/commands/analyze.js');
    const mockRunAnalysis = vi.mocked(runAnalysis);
    mockRunAnalysis.mockResolvedValue({
      repoMap: {
        summary: { totalFiles: 10, analyzedFiles: 10 },
        allFiles: [], highValueFiles: [], lowPriorityFiles: [],
      },
      depGraph: makeMinimalDepGraph(),
      artifacts: {
        repoStructure: {
          projectName: 'test', projectType: 'node', frameworks: [], architecture: { pattern: 'layered' },
          domains: [], apiEndpoints: [], dataModels: [], summary: '',
        },
        llmContext: { ...makeMinimalLLMContext(), callGraph: undefined },
      },
      duration: 0,
    } as never);

    const { handleAnalyzeCodebase } = await import('./analysis.js');
    await handleAnalyzeCodebase(tmpDir, true);
    expect(mockRunAnalysis).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// handleGetFunctionBody
// ============================================================================

describe('handleGetFunctionBody', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  it('returns error when file does not exist', async () => {
    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'nonexistent.ts', 'myFn') as { error: string };
    expect(result.error).toContain('File not found');
  });

  it('returns function body via line scan fallback when no call graph', async () => {
    const src = `export function doSomething(x: number): number {\n  return x + 1;\n}\n`;
    const srcPath = join(tmpDir, 'util.ts');
    await writeFile(srcPath, src, 'utf-8');

    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'util.ts', 'doSomething') as Record<string, unknown>;

    expect(result.functionName).toBe('doSomething');
    expect(result.filePath).toBe('util.ts');
    expect(typeof result.body).toBe('string');
    expect((result.body as string)).toContain('doSomething');
    expect(result.note).toContain('line scan');
  });

  it('returns error when function not found in file', async () => {
    const src = `export function otherFn() {}\n`;
    await writeFile(join(tmpDir, 'a.ts'), src, 'utf-8');

    const { handleGetFunctionBody } = await import('./analysis.js');
    const result = await handleGetFunctionBody(tmpDir, 'a.ts', 'missingFn') as { error: string };
    expect(result.error).toContain('"missingFn"');
  });
});

// ============================================================================
// handleGetDecisions
// ============================================================================

describe('handleGetDecisions', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  it('returns empty decisions when decisions directory does not exist', async () => {
    const { handleGetDecisions } = await import('./analysis.js');
    const result = await handleGetDecisions(tmpDir) as { decisions: unknown[]; note: string };
    expect(result.decisions).toEqual([]);
    expect(result.note).toContain('decisions');
  });

  it('returns list of ADR files from decisions directory', async () => {
    const decisionsDir = join(tmpDir, 'openspec', 'decisions');
    await mkdir(decisionsDir, { recursive: true });
    await writeFile(
      join(decisionsDir, 'adr-001-use-lancedb.md'),
      '# Use LanceDB\n\n**Status**: Accepted\n\nWe chose LanceDB for vector storage.',
      'utf-8'
    );

    const { handleGetDecisions } = await import('./analysis.js');
    const result = await handleGetDecisions(tmpDir) as { count: number; decisions: Array<{ filename: string; title: string; status: string }> };

    expect(result.count).toBe(1);
    expect(result.decisions[0].filename).toBe('adr-001-use-lancedb.md');
    expect(result.decisions[0].title).toBe('Use LanceDB');
    expect(result.decisions[0].status).toBe('Accepted');
  });

  it('filters decisions by query text', async () => {
    const decisionsDir = join(tmpDir, 'openspec', 'decisions');
    await mkdir(decisionsDir, { recursive: true });
    await writeFile(join(decisionsDir, 'adr-001.md'), '# Use LanceDB\n\n**Status**: Accepted\n\nVector storage.', 'utf-8');
    await writeFile(join(decisionsDir, 'adr-002.md'), '# Use Vitest\n\n**Status**: Accepted\n\nTesting framework.', 'utf-8');

    const { handleGetDecisions } = await import('./analysis.js');
    const result = await handleGetDecisions(tmpDir, 'lancedb') as { count: number; decisions: unknown[] };

    expect(result.count).toBe(1);
    expect(result.decisions).toHaveLength(1);
  });
});

// ============================================================================
// handleGetRouteInventory
// ============================================================================

describe('handleGetRouteInventory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
  });

  it('returns cached: true + inventory data when route-inventory.json exists and is valid JSON', async () => {
    const payload = {
      total: 3,
      byMethod: { GET: 2, POST: 1 },
      byFramework: { express: 3 },
      routes: [
        { method: 'GET', path: '/users', framework: 'express', file: 'routes/users.ts', handler: 'getUsers' },
        { method: 'GET', path: '/users/:id', framework: 'express', file: 'routes/users.ts', handler: 'getUser' },
        { method: 'POST', path: '/users', framework: 'express', file: 'routes/users.ts', handler: 'createUser' },
      ],
    };
    await writeAnalysisFile(tmpDir, ARTIFACT_ROUTE_INVENTORY, payload);

    const { handleGetRouteInventory } = await import('./analysis.js');
    const result = await handleGetRouteInventory(tmpDir) as Record<string, unknown>;

    expect(result.cached).toBe(true);
    expect(result.total).toBe(3);
    expect(result.byMethod).toEqual({ GET: 2, POST: 1 });
    expect(result.byFramework).toEqual({ express: 3 });
    expect(Array.isArray(result.routes)).toBe(true);
  });

  it('falls back to live extraction (cached: false) when artifact file is absent', async () => {
    // No artifact written — live extraction runs against empty tmpDir
    const { handleGetRouteInventory } = await import('./analysis.js');
    const result = await handleGetRouteInventory(tmpDir) as Record<string, unknown>;

    expect(result.cached).toBe(false);
    // Structure should have the expected inventory fields
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('byMethod');
    expect(result).toHaveProperty('byFramework');
    expect(result).toHaveProperty('routes');
  });

  it('returns expected total/byMethod/byFramework structure from cached artifact', async () => {
    const payload = {
      total: 5,
      byMethod: { GET: 3, POST: 1, DELETE: 1 },
      byFramework: { nestjs: 4, fastapi: 1 },
      routes: [],
    };
    await writeAnalysisFile(tmpDir, ARTIFACT_ROUTE_INVENTORY, payload);

    const { handleGetRouteInventory } = await import('./analysis.js');
    const result = await handleGetRouteInventory(tmpDir) as Record<string, unknown>;

    expect(result.total).toBe(5);
    expect((result.byMethod as Record<string, number>)['GET']).toBe(3);
    expect((result.byMethod as Record<string, number>)['DELETE']).toBe(1);
    expect((result.byFramework as Record<string, number>)['nestjs']).toBe(4);
  });

  it('handles malformed JSON artifact gracefully — falls through to live extraction', async () => {
    // Write a corrupted artifact file
    const dir = join(tmpDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ARTIFACT_ROUTE_INVENTORY), 'not-valid-json!!!', 'utf-8');

    const { handleGetRouteInventory } = await import('./analysis.js');
    const result = await handleGetRouteInventory(tmpDir) as Record<string, unknown>;

    // Malformed JSON → JSON.parse throws → falls through to live extraction → cached: false
    expect(result.cached).toBe(false);
    expect(result).toHaveProperty('total');
  });
});

// ============================================================================
// handleGetMiddlewareInventory
// ============================================================================

describe('handleGetMiddlewareInventory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns cached: true when middleware-inventory.json exists', async () => {
    const payload = [{ name: 'authMiddleware', file: 'src/middleware/auth.ts' }];
    await writeAnalysisFile(tmpDir, ARTIFACT_MIDDLEWARE_INVENTORY, payload);
    const { handleGetMiddlewareInventory } = await import('./analysis.js');
    const result = await handleGetMiddlewareInventory(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(true);
    expect(result.total).toBe(1);
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it('falls back to live extraction (cached: false) when artifact absent', async () => {
    const { handleGetMiddlewareInventory } = await import('./analysis.js');
    const result = await handleGetMiddlewareInventory(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(false);
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('entries');
  });
});

// ============================================================================
// handleGetSchemaInventory
// ============================================================================

describe('handleGetSchemaInventory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns cached: true when schema-inventory.json exists', async () => {
    const payload = [{ name: 'User', type: 'interface', file: 'src/types.ts' }];
    await writeAnalysisFile(tmpDir, ARTIFACT_SCHEMA_INVENTORY, payload);
    const { handleGetSchemaInventory } = await import('./analysis.js');
    const result = await handleGetSchemaInventory(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(true);
    expect(result.total).toBe(1);
    expect(Array.isArray(result.schemas)).toBe(true);
  });

  it('falls back to live extraction when artifact absent', async () => {
    const { handleGetSchemaInventory } = await import('./analysis.js');
    const result = await handleGetSchemaInventory(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(false);
    expect(result).toHaveProperty('schemas');
  });
});

// ============================================================================
// handleGetUIComponents
// ============================================================================

describe('handleGetUIComponents', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns cached: true when ui-inventory.json exists', async () => {
    const payload = [{ name: 'Button', file: 'src/components/Button.tsx' }];
    await writeAnalysisFile(tmpDir, ARTIFACT_UI_INVENTORY, payload);
    const { handleGetUIComponents } = await import('./analysis.js');
    const result = await handleGetUIComponents(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(true);
    expect(result.total).toBe(1);
    expect(Array.isArray(result.components)).toBe(true);
  });

  it('falls back to live extraction when artifact absent', async () => {
    const { handleGetUIComponents } = await import('./analysis.js');
    const result = await handleGetUIComponents(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(false);
    expect(result).toHaveProperty('components');
  });
});

// ============================================================================
// handleGetEnvVars
// ============================================================================

describe('handleGetEnvVars', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns cached: true when env-inventory.json exists', async () => {
    const payload = [{ name: 'DATABASE_URL', file: 'src/config.ts' }];
    await writeAnalysisFile(tmpDir, ARTIFACT_ENV_INVENTORY, payload);
    const { handleGetEnvVars } = await import('./analysis.js');
    const result = await handleGetEnvVars(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(true);
    expect(result.total).toBe(1);
    expect(Array.isArray(result.envVars)).toBe(true);
  });

  it('falls back to live extraction when artifact absent', async () => {
    const { handleGetEnvVars } = await import('./analysis.js');
    const result = await handleGetEnvVars(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(false);
    expect(result).toHaveProperty('envVars');
  });
});

// ============================================================================
// handleGetExternalPackages
// ============================================================================

describe('handleGetExternalPackages', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns cached: true when external-packages.json exists', async () => {
    const payload = { total: 2, packages: [{ name: 'express', version: '^4.18.0' }] };
    await writeAnalysisFile(tmpDir, ARTIFACT_EXTERNAL_PACKAGES, payload);
    const { handleGetExternalPackages } = await import('./analysis.js');
    const result = await handleGetExternalPackages(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(true);
    expect(result.total).toBe(2);
  });

  it('falls back to live extraction when artifact absent', async () => {
    const { handleGetExternalPackages } = await import('./analysis.js');
    const result = await handleGetExternalPackages(tmpDir) as Record<string, unknown>;
    expect(result.cached).toBe(false);
  });
});

// ============================================================================
// handleGetMinimalContext
// ============================================================================

function makeCallGraph(overrides: Partial<{
  nodes: unknown[]; edges: unknown[];
}> = {}) {
  return {
    nodes: [],
    edges: [],
    entryPoints: [],
    hubFunctions: [],
    layerViolations: [],
    inheritanceEdges: [],
    classes: [],
    stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    ...overrides,
  };
}

describe('handleGetMinimalContext', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error when no call graph available', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'myFn') as { error: string };
    expect(result.error).toMatch(/No call graph/);
  });

  it('returns error when function not found in call graph', async () => {
    readCachedContext.mockResolvedValue({ callGraph: makeCallGraph() });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'nonExistentFn') as { error: string };
    expect(result.error).toMatch(/"nonExistentFn" not found/);
  });

  it('returns function metadata with callers and callees', async () => {
    const node = {
      id: 'src/a.ts::doWork', name: 'doWork', filePath: `${tmpDir}/src/a.ts`,
      signature: 'doWork(x: number): void', language: 'typescript',
      fanIn: 2, fanOut: 1, startLine: 1, endLine: 5,
      isExternal: false, isTest: false,
    };
    const callerNode = {
      id: 'src/b.ts::caller', name: 'caller', filePath: `${tmpDir}/src/b.ts`,
      signature: 'caller()', language: 'typescript',
      fanIn: 0, fanOut: 1, startLine: 1, endLine: 3,
      isExternal: false, isTest: false,
    };
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [node, callerNode],
        edges: [
          { callerId: 'src/b.ts::caller', calleeId: 'src/a.ts::doWork', calleeName: 'doWork', confidence: 'exact', kind: 'calls' },
        ],
      }),
    });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'doWork') as Record<string, unknown>;
    expect((result.function as Record<string, unknown>).name).toBe('doWork');
    expect(Array.isArray(result.callers)).toBe(true);
    expect((result.callers as unknown[]).length).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.callees)).toBe(true);
    expect(Array.isArray(result.testedBy)).toBe(true);
  });

  it('includes testedBy edges when present', async () => {
    const node = {
      id: 'src/a.ts::compute', name: 'compute', filePath: `${tmpDir}/src/a.ts`,
      signature: 'compute()', language: 'typescript',
      fanIn: 0, fanOut: 0, startLine: 1, endLine: 3,
      isExternal: false, isTest: false,
    };
    readCachedContext.mockResolvedValue({
      callGraph: makeCallGraph({
        nodes: [node],
        edges: [
          { callerId: 'src/a.ts::compute', calleeId: 'src/a.test.ts::testCompute', calleeName: 'compute.test.ts', confidence: 'import', kind: 'tested_by' },
        ],
      }),
    });
    const { handleGetMinimalContext } = await import('./analysis.js');
    const result = await handleGetMinimalContext(tmpDir, 'compute') as { testedBy: Array<{ confidence: string }> };
    expect(result.testedBy).toHaveLength(1);
    expect(result.testedBy[0].confidence).toBe('imported');
  });
});

// ============================================================================
// handleGetCluster
// ============================================================================

describe('handleGetCluster', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error when no call graph', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleGetCluster } = await import('./analysis.js');
    const result = await handleGetCluster(tmpDir, 'foo') as { error: string };
    expect(result.error).toMatch(/No call graph/);
  });

  it('returns error when function not found', async () => {
    readCachedContext.mockResolvedValue({ callGraph: makeCallGraph() });
    const { handleGetCluster } = await import('./analysis.js');
    const result = await handleGetCluster(tmpDir, 'missing') as { error: string };
    expect(result.error).toMatch(/"missing" not found/);
  });

  it('returns error when function has no community data', async () => {
    const node = {
      id: 'src/a.ts::fn', name: 'fn', filePath: `${tmpDir}/src/a.ts`,
      fanIn: 0, fanOut: 0, isExternal: false, isTest: false,
      // no communityId
    };
    readCachedContext.mockResolvedValue({ callGraph: makeCallGraph({ nodes: [node] }) });
    const { handleGetCluster } = await import('./analysis.js');
    const result = await handleGetCluster(tmpDir, 'fn') as { error: string };
    expect(result.error).toMatch(/No community data/);
  });

  it('returns cluster members and stats for function with communityId', async () => {
    const mkNode = (name: string) => ({
      id: `src/a.ts::${name}`, name, filePath: `${tmpDir}/src/a.ts`,
      fanIn: 1, fanOut: 1, isExternal: false, isTest: false,
      communityId: 42, communityLabel: 'auth-cluster',
    });
    const nodes = [mkNode('login'), mkNode('logout'), mkNode('refresh')];
    readCachedContext.mockResolvedValue({ callGraph: makeCallGraph({ nodes, edges: [] }) });
    const { handleGetCluster } = await import('./analysis.js');
    const result = await handleGetCluster(tmpDir, 'login') as Record<string, unknown>;
    expect(result.communityId).toBe(42);
    expect(result.communityLabel).toBe('auth-cluster');
    expect((result.stats as Record<string, number>).members).toBe(3);
    expect(Array.isArray(result.functions)).toBe(true);
  });
});

// ============================================================================
// handleDetectChanges
// ============================================================================

describe('handleDetectChanges', () => {
  let tmpDir: string;
  let readCachedContext: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
    readCachedContext = vi.mocked(utils.readCachedContext);
  });

  it('returns error when no call graph', async () => {
    readCachedContext.mockResolvedValue(null);
    const { handleDetectChanges } = await import('./analysis.js');
    const result = await handleDetectChanges(tmpDir) as { error: string };
    expect(result.error).toMatch(/No call graph/);
  });

  it('returns git error when directory is not a git repository', async () => {
    readCachedContext.mockResolvedValue({ callGraph: makeCallGraph() });
    const { handleDetectChanges } = await import('./analysis.js');
    // tmpDir is not a git repo — git diff will fail
    const result = await handleDetectChanges(tmpDir) as { error: string };
    expect(result.error).toMatch(/git diff failed/);
  });
});

// ============================================================================
// handleAuditSpecCoverage
// ============================================================================

describe('handleAuditSpecCoverage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await createTmpDir();
    const utils = await import('./utils.js');
    vi.mocked(utils.validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns error when audit fails (no analysis)', async () => {
    const { handleAuditSpecCoverage } = await import('./analysis.js');
    const result = await handleAuditSpecCoverage(tmpDir) as { error: string };
    // No analysis cache → openloreAudit throws
    expect(result.error).toMatch(/Audit failed/);
  });
});
