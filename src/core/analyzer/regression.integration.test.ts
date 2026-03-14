/**
 * Regression integration tests for VectorIndex and embedding pipeline.
 *
 * Each test documents a specific bug found in production, when it was
 * discovered, and the exact condition that would have caught it earlier.
 *
 * Requires the embedding server:
 *   npm run embed:up
 *
 * Run:
 *   npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorIndex } from './vector-index.js';
import { EmbeddingService } from './embedding-service.js';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';

// ============================================================================
// CONFIG
// ============================================================================

const EMBED_BASE_URL = process.env.EMBED_BASE_URL ?? 'http://localhost:8765/v1';
const EMBED_MODEL = process.env.EMBED_MODEL ?? 'all-MiniLM-L6-v2';

// ============================================================================
// HELPERS
// ============================================================================

async function isServerUp(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function makeNode(
  overrides: Partial<FunctionNode> & Pick<FunctionNode, 'id' | 'name' | 'filePath'>,
): FunctionNode {
  return {
    language: 'TypeScript',
    isAsync: false,
    startIndex: 0,
    endIndex: 100,
    fanIn: 1,
    fanOut: 1,
    ...overrides,
  };
}

// ============================================================================
// BUG: docstrings not searchable (discovered during real-codebase testing)
//
// Root cause: buildText() was not including the docstring field in the text
// passed to the embedding model.  Queries that matched only the docstring
// (and not the function name or signature) returned 0 relevant results.
//
// Fix: confirmed that buildText() now joins [language path name, signature,
//      docstring, skeleton] before embedding.
//
// This describe block is the canonical regression suite for that class of bug.
// Any future change to buildText() must keep all these tests green.
// ============================================================================

describe('Regression: docstrings indexed and searchable', () => {
  let tmpDir: string;
  let embedSvc: EmbeddingService;
  let serverAvailable = false;

  // Fixtures: all names are opaque so that only docstrings carry semantic signal.
  const NODES: FunctionNode[] = [
    makeNode({ id: 'src/payments/stripe.ts::process', name: 'process', filePath: 'src/payments/stripe.ts', fanIn: 2, fanOut: 3 }),
    makeNode({ id: 'src/notifications/push.ts::send',  name: 'send',   filePath: 'src/notifications/push.ts', fanIn: 1, fanOut: 2 }),
    makeNode({ id: 'src/export/pdf.ts::run',           name: 'run',    filePath: 'src/export/pdf.ts', fanIn: 1, fanOut: 2 }),
  ];

  const SIGNATURES: FileSignatureMap[] = [
    {
      path: 'src/payments/stripe.ts',
      language: 'TypeScript',
      entries: [
        {
          kind: 'function',
          name: 'process',
          signature: 'async function process(amount: number, currency: string): Promise<ChargeResult>',
          docstring: 'Charges a customer via Stripe using the stored payment method and handles 3DS authentication',
        },
      ],
    },
    {
      path: 'src/notifications/push.ts',
      language: 'TypeScript',
      entries: [
        {
          kind: 'function',
          name: 'send',
          signature: 'async function send(deviceToken: string, payload: PushPayload): Promise<void>',
          docstring: 'Delivers a push notification to an iOS or Android device via Firebase Cloud Messaging',
        },
      ],
    },
    {
      path: 'src/export/pdf.ts',
      language: 'TypeScript',
      entries: [
        {
          kind: 'function',
          name: 'run',
          signature: 'async function run(template: string, data: Record<string, unknown>): Promise<Buffer>',
          docstring: 'Renders an HTML template to a PDF document using Puppeteer headless Chrome',
        },
      ],
    },
  ];

  beforeAll(async () => {
    serverAvailable = await isServerUp(EMBED_BASE_URL);
    if (!serverAvailable) return;

    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-regression-'));
    embedSvc = new EmbeddingService({ baseUrl: EMBED_BASE_URL, model: EMBED_MODEL });

    await VectorIndex.build(
      tmpDir,
      NODES,
      SIGNATURES,
      new Set<string>(),
      new Set<string>(),
      embedSvc,
    );
  });

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function skipIfDown() {
    if (!serverAvailable) {
      console.warn(`  ⚠ Embedding server not reachable at ${EMBED_BASE_URL} — skipping`);
    }
    return !serverAvailable;
  }

  // ── Regression test R-001 ──────────────────────────────────────────────────
  // Bug:     Docstrings not included in embedded text.
  // Effect:  Query "Stripe payment 3DS" returned empty results even though
  //          src/payments/stripe.ts::process had a matching docstring.
  // Fix:     buildText() now appends docstring to the embedded text.
  // Date:    2026-03 (discovered on KidSearch-Backend real codebase run).

  it('[R-001] "Stripe payment 3DS authentication" retrieves payments::process via docstring', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(
      tmpDir,
      'Stripe payment charge 3DS authentication',
      embedSvc,
      { limit: 3 },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].record.filePath).toBe('src/payments/stripe.ts');
    expect(results[0].record.docstring).toContain('Stripe');
  });

  // ── Regression test R-002 ──────────────────────────────────────────────────
  // Bug:     Same as R-001 but for a different domain (Firebase push).
  // Verifies the fix is not specific to payment-domain vocabulary.

  it('[R-002] "Firebase push notification iOS Android" retrieves notifications::send via docstring', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(
      tmpDir,
      'Firebase Cloud Messaging push notification mobile device',
      embedSvc,
      { limit: 3 },
    );

    expect(results.length).toBeGreaterThan(0);
    const topPaths = results.map(r => r.record.filePath);
    expect(topPaths).toContain('src/notifications/push.ts');
  });

  // ── Regression test R-003 ──────────────────────────────────────────────────
  // Verifies that every result record exposes a non-empty docstring field,
  // so that consumers (MCP handlers, generation pipeline) can rely on it.

  it('[R-003] all result records expose non-empty docstring field', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(
      tmpDir,
      'render PDF HTML Puppeteer headless',
      embedSvc,
      { limit: 3 },
    );

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      // Every fixture has a docstring — none should survive as an empty string
      expect(typeof r.record.docstring).toBe('string');
      expect(r.record.docstring.length).toBeGreaterThan(0);
    }
  });

  // ── Regression test R-004 ──────────────────────────────────────────────────
  // Verifies that signature field is correctly stored and returned,
  // since signature tokens are also included in the embedded text.

  it('[R-004] result records expose non-empty signature field', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(
      tmpDir,
      'generate PDF document from template',
      embedSvc,
      { limit: 3 },
    );

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.record.signature).toBe('string');
      expect(r.record.signature.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// BUG: minFanIn filter silently excluded all results when value was too high
//
// Root cause: The filter was applied after the ANN search but before result
// mapping, causing empty arrays to be returned without error.
//
// This suite verifies the filter boundary conditions.
// ============================================================================

describe('Regression: minFanIn filter boundary conditions', () => {
  let tmpDir: string;
  let embedSvc: EmbeddingService;
  let serverAvailable = false;

  const NODES: FunctionNode[] = [
    makeNode({ id: 'src/core/gateway.ts::route', name: 'route', filePath: 'src/core/gateway.ts', fanIn: 20, fanOut: 5 }),
    makeNode({ id: 'src/core/handler.ts::handle', name: 'handle', filePath: 'src/core/handler.ts', fanIn: 3, fanOut: 2 }),
    makeNode({ id: 'src/core/leaf.ts::leaf', name: 'leaf', filePath: 'src/core/leaf.ts', fanIn: 0, fanOut: 0 }),
  ];

  const SIGNATURES: FileSignatureMap[] = [
    {
      path: 'src/core/gateway.ts',
      language: 'TypeScript',
      entries: [{ kind: 'function', name: 'route', signature: 'function route(req: Request): Handler', docstring: 'Routes an HTTP request to the appropriate handler based on the URL pattern' }],
    },
    {
      path: 'src/core/handler.ts',
      language: 'TypeScript',
      entries: [{ kind: 'function', name: 'handle', signature: 'function handle(ctx: Context): void', docstring: 'Handles a specific request context and writes the response' }],
    },
    {
      path: 'src/core/leaf.ts',
      language: 'TypeScript',
      entries: [{ kind: 'function', name: 'leaf', signature: 'function leaf(): void', docstring: 'A leaf utility function with no callers' }],
    },
  ];

  beforeAll(async () => {
    serverAvailable = await isServerUp(EMBED_BASE_URL);
    if (!serverAvailable) return;

    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-regression-fanin-'));
    embedSvc = new EmbeddingService({ baseUrl: EMBED_BASE_URL, model: EMBED_MODEL });

    await VectorIndex.build(
      tmpDir,
      NODES,
      SIGNATURES,
      new Set<string>(),
      new Set<string>(),
      embedSvc,
    );
  });

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function skipIfDown() {
    if (!serverAvailable) {
      console.warn(`  ⚠ Embedding server not reachable at ${EMBED_BASE_URL} — skipping`);
    }
    return !serverAvailable;
  }

  // ── Regression test R-005 ──────────────────────────────────────────────────
  it('[R-005] minFanIn=0 returns all matching functions', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(
      tmpDir,
      'handle HTTP request routing',
      embedSvc,
      { limit: 10, minFanIn: 0 },
    );

    expect(results.length).toBe(3);
  });

  // ── Regression test R-006 ──────────────────────────────────────────────────
  it('[R-006] minFanIn=5 excludes low-traffic functions', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(
      tmpDir,
      'handle HTTP request routing',
      embedSvc,
      { limit: 10, minFanIn: 5 },
    );

    // Only gateway::route has fanIn=20
    expect(results.length).toBe(1);
    expect(results[0].record.name).toBe('route');
  });

  // ── Regression test R-007 ──────────────────────────────────────────────────
  it('[R-007] minFanIn above all values returns empty array (not an error)', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(
      tmpDir,
      'handle HTTP request routing',
      embedSvc,
      { limit: 10, minFanIn: 999 },
    );

    // Must return [] not throw
    expect(results).toEqual([]);
  });
});

// ============================================================================
// BUG: Incremental build reused stale vectors for renamed functions
//
// Root cause: The incremental cache key was the function ID only.  If a
// function was renamed (different id) but had identical body text, the old
// vector was wrongly reused.  Fix: cache key is now `id::text`.
// ============================================================================

describe('Regression: incremental build cache key includes text', () => {
  let tmpDir: string;
  let embedSvc: EmbeddingService;
  let serverAvailable = false;

  const BASE_NODES: FunctionNode[] = [
    makeNode({ id: 'src/auth.ts::login', name: 'login', filePath: 'src/auth.ts', fanIn: 5, fanOut: 2 }),
  ];

  const BASE_SIGS: FileSignatureMap[] = [
    {
      path: 'src/auth.ts',
      language: 'TypeScript',
      entries: [{ kind: 'function', name: 'login', signature: 'function login(email: string, password: string): Session', docstring: 'Authenticates a user with email and password credentials' }],
    },
  ];

  beforeAll(async () => {
    serverAvailable = await isServerUp(EMBED_BASE_URL);
    if (!serverAvailable) return;

    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-regression-incr-'));
    embedSvc = new EmbeddingService({ baseUrl: EMBED_BASE_URL, model: EMBED_MODEL });

    // Initial build
    await VectorIndex.build(tmpDir, BASE_NODES, BASE_SIGS, new Set(), new Set(), embedSvc, undefined, true);
  });

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  function skipIfDown() {
    if (!serverAvailable) {
      console.warn(`  ⚠ Embedding server not reachable at ${EMBED_BASE_URL} — skipping`);
    }
    return !serverAvailable;
  }

  // ── Regression test R-008 ──────────────────────────────────────────────────
  it('[R-008] incremental rebuild with changed docstring re-embeds the function', async () => {
    if (skipIfDown()) return;

    // Rebuild with updated docstring — text changed, so vector must be re-embedded
    const updatedSigs: FileSignatureMap[] = [
      {
        path: 'src/auth.ts',
        language: 'TypeScript',
        entries: [{ kind: 'function', name: 'login', signature: 'function login(email: string, password: string): Session', docstring: 'Validates OAuth2 token and returns an active session' }],
      },
    ];

    const { embedded, reused } = await VectorIndex.build(
      tmpDir,
      BASE_NODES,
      updatedSigs,
      new Set(),
      new Set(),
      embedSvc,
      undefined,
      /* incremental */ true,
    );

    // The text changed (docstring updated), so it must be re-embedded, not reused
    expect(embedded).toBe(1);
    expect(reused).toBe(0);
  });

  // ── Regression test R-009 ──────────────────────────────────────────────────
  it('[R-009] incremental rebuild with unchanged text reuses cached vector', async () => {
    if (skipIfDown()) return;

    // Same signature + docstring as what was built in R-008
    const sameSigs: FileSignatureMap[] = [
      {
        path: 'src/auth.ts',
        language: 'TypeScript',
        entries: [{ kind: 'function', name: 'login', signature: 'function login(email: string, password: string): Session', docstring: 'Validates OAuth2 token and returns an active session' }],
      },
    ];

    const { embedded, reused } = await VectorIndex.build(
      tmpDir,
      BASE_NODES,
      sameSigs,
      new Set(),
      new Set(),
      embedSvc,
      undefined,
      /* incremental */ true,
    );

    // Text is identical to the previous build — vector must be reused
    expect(reused).toBe(1);
    expect(embedded).toBe(0);
  });
});
