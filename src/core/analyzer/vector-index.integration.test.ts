/**
 * Integration tests for VectorIndex + EmbeddingService
 *
 * Requires the embedding server to be running:
 *   npm run embed:up   (or: docker compose up -d embedding-server)
 *
 * The server URL is configured via EMBED_BASE_URL (default: http://localhost:8765/v1).
 * Tests are skipped automatically when the server is unreachable.
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
    const res = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function makeNode(overrides: Partial<FunctionNode> & Pick<FunctionNode, 'id' | 'name' | 'filePath'>): FunctionNode {
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
// FIXTURES
//
// Functions with intentional semantic clusters so we can assert that
// "authentication" queries surface auth functions, not DB functions, etc.
// ============================================================================

// ============================================================================
// FIXTURES — OPAQUE NAMES (RIG-16)
//
// All functions use generic, semantically meaningless names (process, handle,
// run, execute, compute).  The correct retrieval target can ONLY be identified
// via the docstring or signature — not the function name alone.  These fixtures
// verify that buildText() actually leverages all indexed fields.
// ============================================================================

const OPAQUE_NODES: FunctionNode[] = [
  makeNode({ id: 'src/email/validator.ts::process',   name: 'process',   filePath: 'src/email/validator.ts',   fanIn: 2, fanOut: 1 }),
  makeNode({ id: 'src/http/limiter.ts::handle',       name: 'handle',    filePath: 'src/http/limiter.ts',      fanIn: 5, fanOut: 2 }),
  makeNode({ id: 'src/media/compress.ts::run',        name: 'run',       filePath: 'src/media/compress.ts',    fanIn: 1, fanOut: 3 }),
  makeNode({ id: 'src/billing/tax.ts::compute',       name: 'compute',   filePath: 'src/billing/tax.ts',       fanIn: 3, fanOut: 2 }),
  makeNode({ id: 'src/jobs/scheduler.ts::execute',    name: 'execute',   filePath: 'src/jobs/scheduler.ts',    fanIn: 1, fanOut: 4 }),
  // Decoys with equally generic names but different domains
  makeNode({ id: 'src/search/index.ts::process',      name: 'process',   filePath: 'src/search/index.ts',      fanIn: 2, fanOut: 1 }),
  makeNode({ id: 'src/io/stream.ts::handle',          name: 'handle',    filePath: 'src/io/stream.ts',         fanIn: 3, fanOut: 1 }),
];

const OPAQUE_SIGNATURES: FileSignatureMap[] = [
  {
    path: 'src/email/validator.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'process',
        signature: 'function process(input: string): ValidationResult',
        docstring: 'Validates an email address format using RFC 5322 rules',
      },
    ],
  },
  {
    path: 'src/http/limiter.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'handle',
        signature: 'async function handle(req: Request, res: Response, next: NextFunction): Promise<void>',
        docstring: 'Rate limits incoming HTTP requests using a sliding window algorithm',
      },
    ],
  },
  {
    path: 'src/media/compress.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'run',
        signature: 'async function run(input: Buffer, quality?: number): Promise<Buffer>',
        docstring: 'Compresses images to WebP format with configurable quality level',
      },
    ],
  },
  {
    path: 'src/billing/tax.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'compute',
        signature: 'function compute(subtotal: number, region: string): TaxBreakdown',
        docstring: 'Calculates VAT and regional tax rates for e-commerce transactions',
      },
    ],
  },
  {
    path: 'src/jobs/scheduler.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'execute',
        signature: 'async function execute(job: CronJob): Promise<JobResult>',
        docstring: 'Runs a scheduled background job with retry logic and dead-letter queue support',
      },
    ],
  },
  {
    path: 'src/search/index.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'process',
        signature: 'function process(doc: Document): IndexEntry',
        docstring: 'Tokenizes and indexes a document for full-text search',
      },
    ],
  },
  {
    path: 'src/io/stream.ts',
    language: 'TypeScript',
    entries: [
      {
        kind: 'function',
        name: 'handle',
        signature: 'function handle(chunk: Buffer): void',
        docstring: 'Processes a binary chunk from a readable stream',
      },
    ],
  },
];

const NODES: FunctionNode[] = [
  makeNode({ id: 'src/auth/jwt.ts::verifyToken',    name: 'verifyToken',    filePath: 'src/auth/jwt.ts',    fanIn: 8, fanOut: 2 }),
  makeNode({ id: 'src/auth/jwt.ts::signToken',      name: 'signToken',      filePath: 'src/auth/jwt.ts',    fanIn: 4, fanOut: 1 }),
  makeNode({ id: 'src/auth/session.ts::createSession', name: 'createSession', filePath: 'src/auth/session.ts', fanIn: 3, fanOut: 2 }),
  makeNode({ id: 'src/db/connection.ts::connect',   name: 'connect',        filePath: 'src/db/connection.ts', fanIn: 10, fanOut: 0 }),
  makeNode({ id: 'src/db/query.ts::executeQuery',   name: 'executeQuery',   filePath: 'src/db/query.ts',    fanIn: 6,  fanOut: 3 }),
  makeNode({ id: 'src/db/query.ts::buildSelect',    name: 'buildSelect',    filePath: 'src/db/query.ts',    fanIn: 2,  fanOut: 1 }),
  makeNode({ id: 'src/api/users.ts::getUser',       name: 'getUser',        filePath: 'src/api/users.ts',   fanIn: 5,  fanOut: 2 }),
  makeNode({ id: 'src/api/users.ts::updateUser',    name: 'updateUser',     filePath: 'src/api/users.ts',   fanIn: 2,  fanOut: 3 }),
  makeNode({ id: 'src/utils/hash.ts::hashPassword', name: 'hashPassword',   filePath: 'src/utils/hash.ts',  fanIn: 3,  fanOut: 1 }),
  makeNode({ id: 'src/utils/hash.ts::compareHash',  name: 'compareHash',    filePath: 'src/utils/hash.ts',  fanIn: 2,  fanOut: 1 }),
  makeNode({ id: 'src/cache/redis.ts::setCache',    name: 'setCache',       filePath: 'src/cache/redis.ts', fanIn: 4,  fanOut: 1 }),
  makeNode({ id: 'src/cache/redis.ts::getCache',    name: 'getCache',       filePath: 'src/cache/redis.ts', fanIn: 6,  fanOut: 1 }),
];

const SIGNATURES: FileSignatureMap[] = [
  {
    path: 'src/auth/jwt.ts',
    language: 'TypeScript',
    entries: [
      { kind: 'function', name: 'verifyToken', signature: 'async function verifyToken(token: string): Promise<JWTPayload>', docstring: 'Verify and decode a JWT access token' },
      { kind: 'function', name: 'signToken', signature: 'function signToken(payload: JWTPayload, expiresIn?: string): string', docstring: 'Sign a JWT token with the application secret' },
    ],
  },
  {
    path: 'src/auth/session.ts',
    language: 'TypeScript',
    entries: [
      { kind: 'function', name: 'createSession', signature: 'async function createSession(userId: string): Promise<Session>', docstring: 'Create an authenticated user session' },
    ],
  },
  {
    path: 'src/db/connection.ts',
    language: 'TypeScript',
    entries: [
      { kind: 'function', name: 'connect', signature: 'async function connect(config: DBConfig): Promise<Pool>', docstring: 'Open a PostgreSQL connection pool' },
    ],
  },
  {
    path: 'src/db/query.ts',
    language: 'TypeScript',
    entries: [
      { kind: 'function', name: 'executeQuery', signature: 'async function executeQuery<T>(sql: string, params: unknown[]): Promise<T[]>', docstring: 'Execute a parameterized SQL query and return rows' },
      { kind: 'function', name: 'buildSelect', signature: 'function buildSelect(table: string, conditions: Record<string, unknown>): string', docstring: 'Build a SELECT statement with WHERE conditions' },
    ],
  },
  {
    path: 'src/utils/hash.ts',
    language: 'TypeScript',
    entries: [
      { kind: 'function', name: 'hashPassword', signature: 'async function hashPassword(plain: string): Promise<string>', docstring: 'Hash a plain-text password with bcrypt' },
      { kind: 'function', name: 'compareHash', signature: 'async function compareHash(plain: string, hash: string): Promise<boolean>', docstring: 'Compare a plain-text password against a bcrypt hash' },
    ],
  },
  {
    path: 'src/cache/redis.ts',
    language: 'TypeScript',
    entries: [
      { kind: 'function', name: 'setCache', signature: 'async function setCache(key: string, value: unknown, ttl?: number): Promise<void>', docstring: 'Store a value in Redis with optional TTL' },
      { kind: 'function', name: 'getCache', signature: 'async function getCache<T>(key: string): Promise<T | null>', docstring: 'Retrieve a cached value from Redis' },
    ],
  },
];

// ============================================================================
// TESTS
// ============================================================================

describe('VectorIndex + EmbeddingService (integration)', () => {
  let tmpDir: string;
  let embedSvc: EmbeddingService;
  let serverAvailable = false;

  beforeAll(async () => {
    serverAvailable = await isServerUp(EMBED_BASE_URL);
    if (!serverAvailable) return;

    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-integration-'));
    embedSvc = new EmbeddingService({ baseUrl: EMBED_BASE_URL, model: EMBED_MODEL });

    const hubIds = new Set(['src/db/connection.ts::connect', 'src/auth/jwt.ts::verifyToken']);
    const entryIds = new Set<string>();
    await VectorIndex.build(tmpDir, NODES, SIGNATURES, hubIds, entryIds, embedSvc);
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

  // --------------------------------------------------------------------------
  // Embedding service smoke tests
  // --------------------------------------------------------------------------

  it('health endpoint responds', async () => {
    if (skipIfDown()) return;

    const res = await fetch(`${EMBED_BASE_URL.replace(/\/v1\/?$/, '')}/health`);
    const body = await res.json() as { status: string; model: string; dim: number };
    expect(res.ok).toBe(true);
    expect(body.status).toBe('ok');
    expect(typeof body.dim).toBe('number');
    expect(body.dim).toBeGreaterThan(0);
  });

  it('returns real embedding vectors', async () => {
    if (skipIfDown()) return;

    const vectors = await embedSvc.embed(['authenticate user with JWT']);
    expect(vectors).toHaveLength(1);
    expect(vectors[0].length).toBeGreaterThan(0);
    // all-MiniLM-L6-v2 → 384 dims
    expect(vectors[0].length).toBe(384);
  });

  it('different texts produce different vectors', async () => {
    if (skipIfDown()) return;

    const [v1, v2] = await embedSvc.embed([
      'authenticate user with JWT token',
      'execute SQL query against PostgreSQL',
    ]);
    // Dot product of normalized vectors — should be noticeably < 1
    const dot = v1.reduce((sum, x, i) => sum + x * v2[i], 0);
    expect(dot).toBeLessThan(0.95);
  });

  it('similar texts produce similar vectors (cosine > 0.7)', async () => {
    if (skipIfDown()) return;

    const [v1, v2] = await embedSvc.embed([
      'verify JWT token signature',
      'validate JWT access token',
    ]);
    const dot = v1.reduce((sum, x, i) => sum + x * v2[i], 0);
    expect(dot).toBeGreaterThan(0.7);
  });

  // --------------------------------------------------------------------------
  // Vector index build + search
  // --------------------------------------------------------------------------

  it('index exists after build', () => {
    if (skipIfDown()) return;
    expect(VectorIndex.exists(tmpDir)).toBe(true);
  });

  it('"authenticate with JWT" query returns auth functions first', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(tmpDir, 'authenticate user with JWT token', embedSvc, { limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    const topNames = results.map(r => r.record.name);
    // At least one of the top 3 should be an auth-related function
    const authNames = ['verifyToken', 'signToken', 'createSession', 'hashPassword', 'compareHash'];
    const hasAuth = topNames.some(n => authNames.includes(n));
    expect(hasAuth).toBe(true);
  });

  it('"execute SQL query" returns DB functions first', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(tmpDir, 'run a SQL query against the database', embedSvc, { limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    const topNames = results.map(r => r.record.name);
    const dbNames = ['executeQuery', 'buildSelect', 'connect'];
    const hasDb = topNames.some(n => dbNames.includes(n));
    expect(hasDb).toBe(true);
  });

  it('"cache value in Redis" returns cache functions', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(tmpDir, 'store value in Redis cache with expiry', embedSvc, { limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    const topNames = results.map(r => r.record.name);
    const cacheNames = ['setCache', 'getCache'];
    const hasCache = topNames.some(n => cacheNames.includes(n));
    expect(hasCache).toBe(true);
  });

  it('results are sorted by score ascending (closest first)', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(tmpDir, 'JWT token authentication', embedSvc, { limit: 12 });

    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i - 1].score);
    }
  });

  it('minFanIn filter works with real embeddings', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(tmpDir, 'database connection', embedSvc, {
      limit: 10,
      minFanIn: 5,
    });

    for (const r of results) {
      expect(r.record.fanIn).toBeGreaterThanOrEqual(5);
    }
  });

  it('hub functions are flagged correctly', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(tmpDir, 'verify JWT', embedSvc, { limit: 12 });
    const verifyResult = results.find(r => r.record.name === 'verifyToken');
    const connectResult = results.find(r => r.record.name === 'connect');

    expect(verifyResult?.record.isHub).toBe(true);
    expect(connectResult?.record.isHub).toBe(true);

    // Non-hub functions
    const buildSelectResult = results.find(r => r.record.name === 'buildSelect');
    if (buildSelectResult) {
      expect(buildSelectResult.record.isHub).toBe(false);
    }
  });

  it('batch embedding is consistent: same text → same vector', async () => {
    if (skipIfDown()) return;

    const text = 'authenticate user with JWT';
    const [v1] = await embedSvc.embed([text]);
    const [v2] = await embedSvc.embed([text]);

    // Vectors should be identical (deterministic model)
    expect(v1).toEqual(v2);
  });
});

// ============================================================================
// RIG-16 — Opaque function names: retrieval must rely on docstring / signature
//
// All function names in this suite are generic (`process`, `handle`, `run`…).
// A correct implementation indexes docstrings and signatures; a broken one
// would fail to retrieve the right function because the name alone carries no
// semantic signal.
// ============================================================================

describe('VectorIndex — opaque names (RIG-16)', () => {
  let tmpDir: string;
  let embedSvc: EmbeddingService;
  let serverAvailable = false;

  beforeAll(async () => {
    serverAvailable = await isServerUp(EMBED_BASE_URL);
    if (!serverAvailable) return;

    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-opaque-'));
    embedSvc = new EmbeddingService({ baseUrl: EMBED_BASE_URL, model: EMBED_MODEL });

    await VectorIndex.build(
      tmpDir,
      OPAQUE_NODES,
      OPAQUE_SIGNATURES,
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

  it('index is built from opaque-name fixtures', () => {
    if (skipIfDown()) return;
    expect(VectorIndex.exists(tmpDir)).toBe(true);
  });

  it('"validate email format RFC" → finds src/email/validator.ts::process via docstring', async () => {
    if (skipIfDown()) return;

    // The function is named "process" — the name alone carries zero signal.
    // Only the docstring "Validates an email address format using RFC 5322 rules" disambiguates.
    const results = await VectorIndex.search(tmpDir, 'validate email format RFC 5322', embedSvc, { limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    const top = results[0].record;
    expect(top.filePath).toBe('src/email/validator.ts');
    expect(top.name).toBe('process');
    expect(top.docstring).toContain('RFC 5322');
  });

  it('"rate limiting sliding window HTTP" → finds src/http/limiter.ts::handle via docstring', async () => {
    if (skipIfDown()) return;

    // Named "handle" — indistinguishable from src/io/stream.ts::handle by name.
    // Docstring "Rate limits incoming HTTP requests using a sliding window algorithm" is the signal.
    const results = await VectorIndex.search(tmpDir, 'rate limit HTTP requests sliding window', embedSvc, { limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    const topFilePaths = results.map(r => r.record.filePath);
    expect(topFilePaths).toContain('src/http/limiter.ts');

    const limiterResult = results.find(r => r.record.filePath === 'src/http/limiter.ts');
    expect(limiterResult?.record.docstring).toContain('sliding window');
  });

  it('"compress images WebP quality" → finds src/media/compress.ts::run via docstring', async () => {
    if (skipIfDown()) return;

    // Named "run" — no semantic meaning. Docstring mentions WebP and image compression.
    const results = await VectorIndex.search(tmpDir, 'compress image to WebP format', embedSvc, { limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    const topFilePaths = results.map(r => r.record.filePath);
    expect(topFilePaths).toContain('src/media/compress.ts');
  });

  it('"calculate VAT tax e-commerce" → finds src/billing/tax.ts::compute via docstring', async () => {
    if (skipIfDown()) return;

    // Named "compute" — generic. Docstring specifies VAT and e-commerce domain.
    const results = await VectorIndex.search(tmpDir, 'calculate VAT tax for online purchase', embedSvc, { limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    const topFilePaths = results.map(r => r.record.filePath);
    expect(topFilePaths).toContain('src/billing/tax.ts');
  });

  it('"background job retry dead-letter queue" → finds scheduler::execute via docstring', async () => {
    if (skipIfDown()) return;

    // Named "execute" — but the docstring mentions scheduled background jobs, retry, dead-letter.
    const results = await VectorIndex.search(tmpDir, 'scheduled background job retry dead-letter', embedSvc, { limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    const topFilePaths = results.map(r => r.record.filePath);
    expect(topFilePaths).toContain('src/jobs/scheduler.ts');
  });

  it('docstring is stored and returned on result records', async () => {
    if (skipIfDown()) return;

    // All opaque functions have non-empty docstrings.  Verify they survive round-trip.
    const results = await VectorIndex.search(tmpDir, 'email validation', embedSvc, { limit: 7 });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.record.docstring).toBeTruthy();
      expect(r.record.docstring.length).toBeGreaterThan(10);
    }
  });

  it('signature is stored and returned on result records', async () => {
    if (skipIfDown()) return;

    const results = await VectorIndex.search(tmpDir, 'compress image WebP', embedSvc, { limit: 7 });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.record.signature).toBeTruthy();
    }
  });
});
