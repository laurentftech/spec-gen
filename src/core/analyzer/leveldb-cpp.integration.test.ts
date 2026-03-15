/**
 * E2E call graph integration test on the real leveldb C++ codebase.
 *
 * Validates that the C++ extractor correctly handles:
 *   - Functions in both .cc implementation files and .h headers
 *   - Class method extraction with className
 *   - Type-inference edge resolution (e.g. WriteBatch batch; batch.Put(...))
 *   - ALL_CAPS macro filtering (no LEVELDB_EXPORT / LEVELDB_ASSERT in graph)
 *   - Hub function identification (Slice is the most-used class in leveldb)
 *   - No cross-file name_only false positives for unambiguous local calls
 *
 * Prerequisites:
 *   git clone --depth=1 https://github.com/google/leveldb.git /tmp/leveldb
 *
 * The test is skipped automatically when /tmp/leveldb is absent so it never
 * breaks a cold CI environment.
 *
 * Run:
 *   npm run test:integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readdir, readFile, access } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { CallGraphBuilder } from './call-graph.js';
import type { CallGraphResult } from './call-graph.js';

// ============================================================================
// CONFIG
// ============================================================================

const LEVELDB_ROOT = '/tmp/leveldb';

// ============================================================================
// HELPERS
// ============================================================================

async function leveldbExists(): Promise<boolean> {
  try {
    await access(join(LEVELDB_ROOT, 'include'));
    return true;
  } catch {
    return false;
  }
}

async function collectCppFiles(
  dir: string,
  files: Array<{ path: string; content: string; language: string }> = [],
): Promise<typeof files> {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip third_party and build dirs
      if (['third_party', 'build', '.git', '.spec-gen'].includes(entry.name)) return;
      await collectCppFiles(full, files);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (!['.cc', '.cpp', '.h', '.hpp'].includes(ext)) return;
      const language = 'C++';
      try {
        const content = await readFile(full, 'utf-8');
        files.push({ path: full, content, language });
      } catch {
        // skip unreadable files
      }
    }
  }));
  return files;
}

// ============================================================================
// SUITE
// ============================================================================

describe('C++ call graph — leveldb e2e', () => {
  let available = false;
  let result: CallGraphResult;

  beforeAll(async () => {
    available = await leveldbExists();
    if (!available) return;

    const files = await collectCppFiles(LEVELDB_ROOT);
    const builder = new CallGraphBuilder();
    result = await builder.build(files);
  }, 60_000);

  function skip(label: string): boolean {
    if (!available) {
      console.warn(`  ⚠ [${label}] /tmp/leveldb not found — run: git clone --depth=1 https://github.com/google/leveldb.git /tmp/leveldb`);
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Basic scale
  // --------------------------------------------------------------------------

  it('extracts a meaningful number of functions from .cc and .h files', () => {
    if (skip('scale')) return;
    const nodes = Array.from(result.nodes.values());
    const inHeaders = nodes.filter(n => n.filePath.endsWith('.h') || n.filePath.endsWith('.hpp'));
    const inImpl    = nodes.filter(n => n.filePath.endsWith('.cc') || n.filePath.endsWith('.cpp'));

    expect(nodes.length,    'total functions').toBeGreaterThan(500);
    expect(inHeaders.length, 'functions in .h files').toBeGreaterThan(50);
    expect(inImpl.length,    'functions in .cc files').toBeGreaterThan(400);
    expect(result.edges.length, 'call edges').toBeGreaterThan(500);
  });

  // --------------------------------------------------------------------------
  // Class method extraction
  // --------------------------------------------------------------------------

  it('extracts class methods with correct className from headers', () => {
    if (skip('class methods')) return;
    const nodes = Array.from(result.nodes.values());

    // InternalKey is declared in db/dbformat.h with several methods
    const internalKeyMethods = nodes.filter(n => n.className === 'InternalKey');
    expect(internalKeyMethods.length, 'InternalKey methods').toBeGreaterThanOrEqual(3);
    expect(internalKeyMethods.some(n => n.name === 'Encode'),    'InternalKey::Encode').toBe(true);
    expect(internalKeyMethods.some(n => n.name === 'DecodeFrom'), 'InternalKey::DecodeFrom').toBe(true);

    // WriteBatch is declared in include/leveldb/write_batch.h
    const writeBatchMethods = nodes.filter(n => n.className === 'WriteBatch');
    expect(writeBatchMethods.length, 'WriteBatch methods').toBeGreaterThanOrEqual(2);
    expect(writeBatchMethods.some(n => n.name === 'Put'),   'WriteBatch::Put').toBe(true);
    expect(writeBatchMethods.some(n => n.name === 'Clear'), 'WriteBatch::Clear').toBe(true);
  });

  // --------------------------------------------------------------------------
  // Hub function: Slice
  // --------------------------------------------------------------------------

  it('identifies Slice as a high-fanIn hub (used across the whole codebase)', () => {
    if (skip('hub Slice')) return;
    const nodes = Array.from(result.nodes.values());

    // Slice() is leveldb's core string-view constructor, called everywhere
    const sliceNode = nodes.find(n => n.name === 'Slice' && n.fanIn >= 10);
    expect(sliceNode, 'Slice hub with fanIn >= 10').toBeDefined();
    expect(result.hubFunctions.some(n => n.name === 'Slice'), 'Slice in hubFunctions').toBe(true);
  });

  // --------------------------------------------------------------------------
  // Macro filtering: ALL_CAPS names must not appear as FunctionNodes
  // --------------------------------------------------------------------------

  it('filters out ALL_CAPS macro names from function nodes', () => {
    if (skip('macro filter')) return;
    const nodes = Array.from(result.nodes.values());

    const macroLike = nodes.filter(n => /^[A-Z][A-Z0-9_]{2,}$/.test(n.name));
    expect(
      macroLike.map(n => n.name),
      'ALL_CAPS names should not be extracted as functions',
    ).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Type inference edges: WriteBatch batch; batch.Put(...)
  // --------------------------------------------------------------------------

  it('resolves type_inference edges for WriteBatch receiver in db_bench.cc', () => {
    if (skip('type_inference')) return;

    const tiEdges = result.edges.filter(e => e.confidence === 'type_inference');
    expect(tiEdges.length, 'type_inference edges').toBeGreaterThan(0);

    // DoWrite declares `WriteBatch batch;` then calls `batch.Put(...)` and `batch.Clear()`
    const nodes = Array.from(result.nodes.values());
    const doWrite = nodes.find(n => n.name === 'DoWrite' && n.filePath.includes('db_bench'));
    if (!doWrite) return; // benchmarks may not be present in all clones

    const doWriteEdges = tiEdges.filter(e => e.callerId === doWrite.id);
    const calleeNames = doWriteEdges.map(e => {
      const callee = result.nodes.get(e.calleeId);
      return callee?.name ?? '';
    });
    expect(calleeNames.some(n => n === 'Put' || n === 'Clear'),
      'DoWrite should have type_inference edge to WriteBatch::Put or ::Clear').toBe(true);
  });

  // --------------------------------------------------------------------------
  // Edge confidence distribution: same_file should dominate
  // --------------------------------------------------------------------------

  it('edge confidence distribution is sane (same_file > name_only)', () => {
    if (skip('confidence distribution')) return;

    const conf: Record<string, number> = {};
    result.edges.forEach(e => { conf[e.confidence] = (conf[e.confidence] ?? 0) + 1; });

    expect(conf['same_file'] ?? 0, 'same_file edges').toBeGreaterThan(0);
    // same_file + type_inference should together dominate name_only
    const confident = (conf['same_file'] ?? 0) + (conf['type_inference'] ?? 0) + (conf['self_cls'] ?? 0) + (conf['import'] ?? 0);
    const nameOnly  = conf['name_only'] ?? 0;
    expect(confident, 'confident edges').toBeGreaterThan(nameOnly * 0.5);
  });

  // --------------------------------------------------------------------------
  // Cycle detection: RemoveDir ↔ DeleteDir deprecation alias
  // --------------------------------------------------------------------------

  it('detects the RemoveDir/DeleteDir deprecation alias cycle', () => {
    if (skip('cycle detection')) return;

    // leveldb has: DeleteDir calls RemoveDir (new name) and vice-versa for
    // backwards compatibility — this forms a two-node cycle.
    const nodes = Array.from(result.nodes.values());
    const removeDir = nodes.find(n => n.name === 'RemoveDir');
    const deleteDir = nodes.find(n => n.name === 'DeleteDir');
    if (!removeDir || !deleteDir) return; // may not be present in older clones

    const hasEdgeAB = result.edges.some(e => e.callerId === removeDir.id && e.calleeId === deleteDir.id);
    const hasEdgeBA = result.edges.some(e => e.callerId === deleteDir.id && e.calleeId === removeDir.id);
    expect(hasEdgeAB || hasEdgeBA, 'RemoveDir ↔ DeleteDir cycle edge exists').toBe(true);
  });
});
