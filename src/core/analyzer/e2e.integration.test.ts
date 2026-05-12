/**
 * RIG-17 — End-to-end pipeline test on a real repository
 *
 * Uses the openlore codebase itself as the fixture.  The test opens the
 * vector index produced by `openlore analyze --embed` (already on disk) and
 * verifies that business-level queries return the correct source files and
 * that indexed functions carry non-empty docstrings when the source has them.
 *
 * Prerequisites:
 *   npm run embed:up          # start the embedding server
 *   openlore analyze --embed  # (re)build the index
 *   npm run test:integration
 *
 * The test is skipped automatically when either the embedding server or the
 * index is missing so it never breaks a cold CI environment.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VectorIndex } from './vector-index.js';
import { EmbeddingService } from './embedding-service.js';

// ============================================================================
// CONFIG
// ============================================================================

const EMBED_BASE_URL = process.env.EMBED_BASE_URL ?? 'http://localhost:8765/v1';
const EMBED_MODEL    = process.env.EMBED_MODEL    ?? 'all-MiniLM-L6-v2';

/** Root of the openlore repo (two levels up from src/core/analyzer/) */
const REPO_ROOT  = resolve(import.meta.dirname, '../../../');
const INDEX_DIR  = join(REPO_ROOT, '.openlore/analysis');

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

// ============================================================================
// KNOWN QUERIES — business concepts that must map to specific openlore files
//
// Each entry states what a developer would ask and which file(s) must appear
// in the top-5 results.  Derived from manual inspection of the codebase.
// ============================================================================

// Hard queries — CANNOT be answered by matching on function name or file path alone.
// The correct file is only discoverable via docstring or body content.
// Each entry documents WHY a name-only matcher would fail.
const KNOWN_QUERIES: Array<{
  query: string;
  mustInclude: string[];   // relative file paths that must appear in top-5
  description: string;
  nameMatchWouldFail: string;
}> = [

  // ── Hard: opaque names, purpose only in docstring ──────────────────────────

  {
    // rrfScore() — name is an IR acronym, reveals nothing to a non-specialist.
    // Docstring: "Reciprocal Rank Fusion: merges two ranked lists into a single relevance score."
    query: 'merge dense embedding ranking and sparse keyword ranking into a single score',
    mustInclude: ['src/core/analyzer/vector-index.ts'],
    description: 'rrfScore — Reciprocal Rank Fusion (opaque acronym name)',
    nameMatchWouldFail: '"rrfScore" gives no hint of "merge ranked lists" or "hybrid search"',
  },
  {
    // astChunkContent() — name hints at "chunk", but hides the key behaviour:
    // "Falls back to blank-line chunking" and "prefixes each chunk with the import block."
    // Docstring: "Chunk content at real AST declaration boundaries using tree-sitter.
    //  Each chunk after the first is prefixed with the file's imports block."
    query: 'split code at class and function declaration boundaries then prepend import header to each chunk',
    mustInclude: ['src/core/analyzer/ast-chunker.ts'],
    description: 'astChunkContent — AST boundary chunking with import header replication',
    nameMatchWouldFail: '"astChunkContent" doesn\'t reveal "prepend imports" or "tree-sitter fallback"',
  },
  {
    // generateCodebaseDigest() — "digest" is vague. Purpose: generate a compact
    // agent-readable CODEBASE.md designed to be included in CLAUDE.md so agents
    // absorb architectural context passively at session start.
    // Module JSDoc: "Designed to be included in CLAUDE.md / .clinerules so agents
    //  absorb architectural context passively at session start, without needing to call any MCP tool."
    query: 'produce compact agent-readable CODEBASE.md included in CLAUDE.md for passive architectural context at session start',
    mustInclude: ['src/core/analyzer/codebase-digest.ts'],
    description: 'generateCodebaseDigest — agent-readable CODEBASE.md generator',
    nameMatchWouldFail: '"digest" reveals nothing about agent integration, CLAUDE.md, or passive context loading',
  },
  {
    // semanticFiles() — private method name reveals nothing. Key behaviour documented in JSDoc:
    // "Generation retrieval strategy: semantic-first → graph expansion.
    //  1. Semantic search identifies seed files relevant to the query.
    //  2. Graph expansion (depth-1 callees) adds files called by the seed functions."
    // The phrase "Generation retrieval strategy" only appears in this docstring and
    // is specific enough to distinguish it from the MCP semantic search handlers.
    query: 'generation retrieval strategy semantic-first followed by graph expansion depth-1 callees for indirect implementations',
    mustInclude: ['src/core/generator/spec-pipeline.ts'],
    description: 'semanticFiles — semantic seed + depth-1 callee expansion',
    nameMatchWouldFail: '"semanticFiles" doesn\'t hint at graph expansion or that this is a generation retrieval strategy',
  },
  {
    // resolveProviderConfig() — generic name. Key content: 5-tier priority
    // cascade (Gemini > Anthropic > OpenAI-compat URL > config file > OpenAI key).
    // Docstring comment at module level enumerates the exact priority order.
    query: 'pick LLM provider by checking Gemini key then Anthropic then OpenAI compatible base URL then config file',
    mustInclude: ['src/core/services/chat-agent.ts'],
    description: 'resolveProviderConfig — 5-tier provider priority cascade',
    nameMatchWouldFail: '"resolveProviderConfig" gives no hint of priority order or which keys override which',
  },
  {
    // compositeScore() — minimal name. Content: weighted blend of semantic
    // distance and structural role bonus (hub/entry/orchestrator get a boost).
    // Docstring: "Composite score = semantic * INSERTION_SEMANTIC_WEIGHT + structuralBonus * INSERTION_STRUCTURAL_WEIGHT"
    query: 'blend semantic distance with structural role bonus to rank function insertion points',
    mustInclude: ['src/core/services/mcp-handlers/semantic.ts'],
    description: 'compositeScore — semantic + structural weighted ranking',
    nameMatchWouldFail: '"compositeScore" doesn\'t reveal the dual-signal weighting or role bonuses',
  },
  {
    // getSkeletonContent() — sounds like "extract function body". Real purpose:
    // strip logs, inline comments, and non-JSDoc blocks while preserving control
    // flow, calls, variable names, and return/throw statements.
    // Docstring: "Strip implementation noise from source code."
    query: 'strip logging statements and inline comments while keeping control flow and function calls for LLM embedding',
    mustInclude: ['src/core/analyzer/code-shaper.ts'],
    description: 'getSkeletonContent — noise stripping for LLM context',
    nameMatchWouldFail: '"getSkeletonContent" doesn\'t reveal noise removal, log stripping, or JSDoc preservation',
  },
  {
    // isSkeletonWorthIncluding() — meta predicate. Content: 20% reduction
    // threshold heuristic — only include skeleton if it saves ≥20% tokens.
    // Docstring: "Returns true when the skeleton achieves a meaningful size
    //  reduction (at least 20% smaller than the original)."
    query: 'decide whether stripped code skeleton saves enough tokens to justify including it over raw body',
    mustInclude: ['src/core/analyzer/code-shaper.ts'],
    description: 'isSkeletonWorthIncluding — 20% token reduction heuristic',
    nameMatchWouldFail: 'name sounds like a simple boolean check; the 20% threshold is invisible without the docstring',
  },

  // ── Medium: name gives partial hint but query tests body/docstring content ──

  {
    // VectorIndex.build() incremental path — "build" is generic but the
    // incremental caching behaviour (text-hash cache, Array.from conversion
    // for Arrow typed arrays) is only in the body.
    query: 'cache embedding vectors by text hash to skip re-embedding unchanged functions on subsequent runs',
    mustInclude: ['src/core/analyzer/vector-index.ts'],
    description: 'VectorIndex.build — incremental cache by text hash',
    nameMatchWouldFail: '"build" doesn\'t suggest caching, text hashing, or Arrow typed array conversion',
  },
  {
    // buildGraphPromptSection() — sounds like prompt building, but the key
    // semantic: "represent large file as call graph topology to reduce tokens
    // instead of including full source". Returns null to signal chunking fallback.
    query: 'represent oversized file as call graph topology to avoid including full source in LLM prompt',
    mustInclude: ['src/core/analyzer/subgraph-extractor.ts'],
    description: 'buildGraphPromptSection — topology substitution for large files',
    nameMatchWouldFail: '"buildGraphPromptSection" doesn\'t reveal token reduction or the null-as-fallback-signal pattern',
  },
  {
    // Duplicate detection — Jaccard similarity for near-clone (Type 3) detection.
    // The threshold (0.7) and algorithm name only appear in docstring/body.
    query: 'measure token overlap between two functions using Jaccard similarity to find near-duplicate code',
    mustInclude: ['src/core/analyzer/duplicate-detector.ts'],
    description: 'duplicate detector — Jaccard similarity for Type 3 near-clones',
    nameMatchWouldFail: 'file name says "duplicate" but Jaccard/Type-3 only appear in body — a simpler test would miss the algorithm',
  },
  {
    // Significance scorer — ranks files for LLM context inclusion. Key content:
    // combines connectivity (importedBy count), name-based score, and path-based score.
    // The `buildFileRelationships` function docstring: "Build file relationships from import analysis"
    // `SignificanceScorer.setRelationships`: "Set file relationships for connectivity scoring"
    // None of this is guessable from the name "SignificanceScorer".
    query: 'score files by import connectivity relationships and path patterns to rank which files matter most',
    mustInclude: ['src/core/analyzer/significance-scorer.ts'],
    description: 'significance scorer — import connectivity + path-based ranking',
    nameMatchWouldFail: '"significance" is vague; the connectivity + path combo is only in the docstrings',
  },
];

// ============================================================================
// TESTS
// ============================================================================

describe('RIG-17 — e2e pipeline on real openlore codebase', () => {
  let serverAvailable = false;
  let indexExists = false;
  let embedSvc: EmbeddingService;

  beforeAll(async () => {
    serverAvailable = await isServerUp(EMBED_BASE_URL);
    indexExists     = VectorIndex.exists(INDEX_DIR);
    if (serverAvailable) {
      embedSvc = new EmbeddingService({ baseUrl: EMBED_BASE_URL, model: EMBED_MODEL });
    }
  });

  function skipIfNotReady(label: string): boolean {
    if (!indexExists) {
      console.warn(`  ⚠ [${label}] No index at ${INDEX_DIR} — run "openlore analyze --embed" first`);
      return true;
    }
    if (!serverAvailable) {
      console.warn(`  ⚠ [${label}] Embedding server not reachable at ${EMBED_BASE_URL}`);
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Sanity — index exists and has rows
  // --------------------------------------------------------------------------

  it('index exists on disk', () => {
    if (!indexExists) {
      console.warn(`  ⚠ No index at ${INDEX_DIR} — run "openlore analyze --embed" first`);
      return;
    }
    expect(VectorIndex.exists(INDEX_DIR)).toBe(true);
  });

  it('index has a meaningful number of functions (>= 100)', async () => {
    if (!indexExists) return;

    // Open the table directly to count rows without embedding
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(join(INDEX_DIR, 'vector-index'));
    const table = await db.openTable('functions');
    const rows = await table.query().toArray();
    expect(rows.length).toBeGreaterThanOrEqual(100);
  });

  // --------------------------------------------------------------------------
  // Docstring coverage — functions that have docstrings in source must have
  // non-empty text in the index (regression for the "docstrings not indexed" bug)
  // --------------------------------------------------------------------------

  it('indexed functions with known docstrings have non-empty text', async () => {
    if (!indexExists) return;

    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(join(INDEX_DIR, 'vector-index'));
    const table = await db.openTable('functions');
    const rows = await table.query().toArray() as Array<{ id: string; text: string }>;

    // Functions known to have docstrings in openlore source
    const knownDocstringFns = [
      'VectorIndex.build',
      'VectorIndex.search',
      'EmbeddingService.embed',
      'generateCodebaseDigest',
    ];

    for (const fnName of knownDocstringFns) {
      const row = rows.find(r => r.id.includes(fnName) || r.text.includes(fnName));
      if (!row) continue; // function may have been renamed — skip gracefully
      expect(row.text.length, `${fnName} text should be non-trivial`).toBeGreaterThan(30);
    }
  });

  // --------------------------------------------------------------------------
  // Semantic retrieval — known business queries must surface the right files
  // --------------------------------------------------------------------------

  for (const { query, mustInclude, description } of KNOWN_QUERIES) {
    it(`query: "${description}"`, async () => {
      if (skipIfNotReady(description)) return;

      const results = await VectorIndex.search(INDEX_DIR, query, embedSvc, { limit: 5 });
      const returnedPaths = results.map(r => r.record.filePath);

      for (const expected of mustInclude) {
        const found = returnedPaths.some(p => p.includes(expected) || p.endsWith(expected));
        expect(found, `Expected "${expected}" in top-5 for: "${query}"\nGot: ${returnedPaths.join(', ')}`).toBe(true);
      }
    });
  }

  // --------------------------------------------------------------------------
  // GraphRAG — depth-1 call graph expansion adds callee files that semantic
  // search alone would miss.
  //
  // Pattern mirrors SpecGenerationPipeline.semanticFiles():
  //   1. VectorIndex.search seeds the file set
  //   2. For each node in a seed file, add all direct callees
  //
  // The test picks queries where the callee file is semantically distant from
  // the query (it would never appear in top-5 without expansion), verifying
  // that the call graph adds genuine recall value.
  // --------------------------------------------------------------------------

  it('GraphRAG: graph expansion adds ast-chunker callee (signature-extractor) not reachable by semantic search', async () => {
    if (skipIfNotReady('GraphRAG — ast-chunker expansion')) return;

    // Step 1: semantic seed
    const query = 'split code at class and function declaration boundaries then prepend import header to each chunk';
    const seedResults = await VectorIndex.search(INDEX_DIR, query, embedSvc, { limit: 5 });
    const seedPaths = new Set(seedResults.map(r => r.record.filePath));

    // ast-chunker.ts must be in the seed (verified by hard-query tests)
    expect([...seedPaths].some(p => p.includes('ast-chunker')), 'ast-chunker.ts not in semantic seed').toBe(true);

    // signature-extractor.ts must NOT be in the semantic-only top-5
    expect([...seedPaths].some(p => p.includes('signature-extractor')),
      'signature-extractor.ts unexpectedly in semantic top-5 — graph expansion test loses value').toBe(false);

    // Step 2: load serialized call graph from analysis artifacts
    const ctx = JSON.parse(await readFile(join(INDEX_DIR, 'llm-context.json'), 'utf-8')) as {
      callGraph: { nodes: Array<{ id: string; filePath: string }>; edges: Array<{ callerId: string; calleeId: string }> };
    };
    const cg = ctx.callGraph;
    const nodeFile = new Map(cg.nodes.map(n => [n.id, n.filePath]));

    // Step 3: depth-1 expansion
    const expandedPaths = new Set(seedPaths);
    for (const node of cg.nodes) {
      if (!seedPaths.has(node.filePath)) continue;
      for (const edge of cg.edges) {
        if (edge.callerId !== node.id) continue;
        const calleePath = nodeFile.get(edge.calleeId);
        if (calleePath) expandedPaths.add(calleePath);
      }
    }

    // signature-extractor.ts is called by ast-chunker.ts — must appear after expansion
    expect([...expandedPaths].some(p => p.includes('signature-extractor')),
      `signature-extractor.ts not found after graph expansion.\nExpanded: ${[...expandedPaths].join(', ')}`).toBe(true);
  });

  it('GraphRAG: graph expansion adds vector-index callee (code-shaper) not reachable by semantic search', async () => {
    if (skipIfNotReady('GraphRAG — vector-index expansion')) return;

    // Step 1: semantic seed
    const query = 'merge dense embedding ranking and sparse keyword ranking into a single score';
    const seedResults = await VectorIndex.search(INDEX_DIR, query, embedSvc, { limit: 5 });
    const seedPaths = new Set(seedResults.map(r => r.record.filePath));

    // vector-index.ts must be in the seed (verified by rrfScore hard-query test)
    expect([...seedPaths].some(p => p.includes('vector-index.ts')), 'vector-index.ts not in semantic seed').toBe(true);

    // code-shaper.ts must NOT be in the semantic-only top-5
    expect([...seedPaths].some(p => p.includes('code-shaper')),
      'code-shaper.ts unexpectedly in semantic top-5 — graph expansion test loses value').toBe(false);

    // Step 2 + 3: load call graph and expand
    const ctx = JSON.parse(await readFile(join(INDEX_DIR, 'llm-context.json'), 'utf-8')) as {
      callGraph: { nodes: Array<{ id: string; filePath: string }>; edges: Array<{ callerId: string; calleeId: string }> };
    };
    const cg = ctx.callGraph;
    const nodeFile = new Map(cg.nodes.map(n => [n.id, n.filePath]));

    const expandedPaths = new Set(seedPaths);
    for (const node of cg.nodes) {
      if (!seedPaths.has(node.filePath)) continue;
      for (const edge of cg.edges) {
        if (edge.callerId !== node.id) continue;
        const calleePath = nodeFile.get(edge.calleeId);
        if (calleePath) expandedPaths.add(calleePath);
      }
    }

    // code-shaper.ts is called by vector-index.ts for skeleton body extraction
    expect([...expandedPaths].some(p => p.includes('code-shaper')),
      `code-shaper.ts not found after graph expansion.\nExpanded: ${[...expandedPaths].join(', ')}`).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Result quality — scores in valid range, no undefined fields
  // --------------------------------------------------------------------------

  it('search results have valid scores and required fields', async () => {
    if (skipIfNotReady('result quality')) return;

    const results = await VectorIndex.search(INDEX_DIR, 'parse call graph from source files', embedSvc, { limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    for (const { record, score } of results) {
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(record.id).toBeTruthy();
      expect(record.filePath).toBeTruthy();
      expect(record.name).toBeTruthy();
      expect(record.text.length).toBeGreaterThan(0);
    }
  });
});
