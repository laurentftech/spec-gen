/**
 * VectorIndex
 *
 * Builds and queries a LanceDB vector index over the call graph functions.
 * Each function is represented by a document combining its signature, docstring,
 * file path, language, and topological metadata (fanIn/fanOut, hub, entry point).
 *
 * Storage: <outputDir>/vector-index/  (LanceDB database folder)
 * Table name: "functions"
 *
 * Usage:
 *   // Build (after spec-gen analyze --embed)
 *   await VectorIndex.build(outputDir, nodes, signatures, hubIds, entryPointIds, embedSvc);
 *
 *   // Search
 *   const results = await VectorIndex.search(outputDir, "authenticate user with JWT", embedSvc);
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';
import type { EmbeddingService } from './embedding-service.js';
import { getSkeletonContent, isSkeletonWorthIncluding } from './code-shaper.js';

// ============================================================================
// TYPES
// ============================================================================

export interface FunctionRecord {
  id: string;
  name: string;
  filePath: string;
  className: string;
  language: string;
  signature: string;
  docstring: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
  isEntryPoint: boolean;
  /** Concatenated text used for embedding */
  text: string;
  /** Embedding vector */
  vector: number[];
}

export interface SearchResult {
  record: Omit<FunctionRecord, 'vector'>;
  /** Distance score (lower = more similar) */
  score: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DB_FOLDER = 'vector-index';
const TABLE_NAME = 'functions';

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build the text to embed for a function.
 * Combines language, path, qualified name, signature, docstring, and skeleton body.
 */
function buildText(
  node: FunctionNode,
  signature: string,
  docstring: string,
  fileContents?: Map<string, string>
): string {
  const qualifiedName = node.className
    ? `${node.className}.${node.name}`
    : node.name;

  const parts = [`[${node.language}] ${node.filePath} ${qualifiedName}`];
  if (signature) parts.push(signature);
  if (docstring) parts.push(docstring);

  // Append skeleton body when file contents are available.
  // The skeleton strips noise (logs, comments) while preserving business-logic signals
  // (variable names, control flow, calls, return/throw). Only included when it provides
  // meaningful reduction over the raw body (≥20% smaller).
  if (fileContents && node.startIndex < node.endIndex) {
    const src = fileContents.get(node.filePath);
    if (src) {
      const body = src.slice(node.startIndex, node.endIndex);
      if (body.trim()) {
        const skeleton = getSkeletonContent(body, node.language);
        if (isSkeletonWorthIncluding(body, skeleton)) {
          parts.push(skeleton);
        }
      }
    }
  }

  return parts.join('\n');
}

/**
 * Build a lookup map: filePath → entries[] from FileSignatureMap[]
 */
function buildSignatureIndex(
  signatures: FileSignatureMap[]
): Map<string, FileSignatureMap['entries']> {
  const index = new Map<string, FileSignatureMap['entries']>();
  for (const fsm of signatures) {
    index.set(fsm.path, fsm.entries);
  }
  return index;
}

/**
 * Find the best matching signature entry for a FunctionNode.
 */
function findSignatureEntry(
  node: FunctionNode,
  sigIndex: Map<string, FileSignatureMap['entries']>
): { signature: string; docstring: string } {
  const entries = sigIndex.get(node.filePath) ?? [];
  const match = entries.find(e => e.name === node.name);
  if (!match) return { signature: '', docstring: '' };
  return {
    signature: match.signature ?? '',
    docstring: match.docstring ?? '',
  };
}

// ============================================================================
// VECTOR INDEX
// ============================================================================

export class VectorIndex {
  /**
   * Build (or rebuild) the vector index from call graph nodes + signatures.
   * Overwrites any existing index.
   */
  static async build(
    outputDir: string,
    nodes: FunctionNode[],
    signatures: FileSignatureMap[],
    hubIds: Set<string>,
    entryPointIds: Set<string>,
    embedSvc: EmbeddingService,
    /** Optional map of filePath → source content for skeleton-based body indexing */
    fileContents?: Map<string, string>
  ): Promise<void> {
    const { connect } = await import('@lancedb/lancedb');

    if (nodes.length === 0) {
      throw new Error('No functions to index');
    }

    const sigIndex = buildSignatureIndex(signatures);

    // Build records from call graph nodes
    const nodeIds = new Set(nodes.map(n => n.id));
    const records: Omit<FunctionRecord, 'vector'>[] = nodes.map(node => {
      const { signature, docstring } = findSignatureEntry(node, sigIndex);
      return {
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        className: node.className ?? '',
        language: node.language,
        signature,
        docstring,
        fanIn: node.fanIn,
        fanOut: node.fanOut,
        isHub: hubIds.has(node.id),
        isEntryPoint: entryPointIds.has(node.id),
        text: buildText(node, signature, docstring, fileContents),
      };
    });

    // Also index signature entries that have no call graph node (constants, type aliases, etc.)
    for (const fsm of signatures) {
      for (const entry of fsm.entries) {
        const syntheticId = `${fsm.path}::${entry.name}`;
        if (nodeIds.has(syntheticId)) continue; // already covered by call graph
        // Skip if any call graph node from this file matches the name
        if (nodes.some(n => n.filePath === fsm.path && n.name === entry.name)) continue;
        const sig = entry.signature ?? '';
        const doc = entry.docstring ?? '';
        records.push({
          id: syntheticId,
          name: entry.name,
          filePath: fsm.path,
          className: '',
          language: fsm.language,
          signature: sig,
          docstring: doc,
          fanIn: 0,
          fanOut: 0,
          isHub: false,
          isEntryPoint: false,
          text: `[${fsm.language}] ${fsm.path} ${entry.name}\n${sig}${doc ? '\n' + doc : ''}`,
        });
      }
    }

    // Batch-embed all texts
    const texts = records.map(r => r.text);
    const vectors = await embedSvc.embed(texts);

    if (vectors.length !== records.length) {
      throw new Error(
        `Embedding count mismatch: expected ${records.length}, got ${vectors.length}`
      );
    }

    // Assemble final records with vectors
    const fullRecords: FunctionRecord[] = records.map((r, i) => ({
      ...r,
      vector: vectors[i],
    }));

    // Connect to LanceDB and write table
    const dbPath = join(outputDir, DB_FOLDER);
    const db = await connect(dbPath);
    await db.createTable(TABLE_NAME, fullRecords as unknown as Record<string, unknown>[], { mode: 'overwrite' });
  }

  /**
   * Semantic search over the index.
   * Returns up to `limit` results sorted by similarity (closest first).
   */
  static async search(
    outputDir: string,
    query: string,
    embedSvc: EmbeddingService,
    opts: {
      limit?: number;
      language?: string;
      minFanIn?: number;
    } = {}
  ): Promise<SearchResult[]> {
    const { connect } = await import('@lancedb/lancedb');

    const { limit = 10, language, minFanIn } = opts;

    // Embed the query
    const [queryVector] = await embedSvc.embed([query]);
    if (!queryVector) {
      throw new Error('Failed to embed query');
    }

    const dbPath = join(outputDir, DB_FOLDER);
    if (!VectorIndex.exists(outputDir)) {
      throw new Error(
        'Vector index not found. Run "spec-gen analyze --embed" first.'
      );
    }
    const db = await connect(dbPath);
    const table = await db.openTable(TABLE_NAME);

    // Fetch more candidates than requested so post-filtering still yields `limit` results.
    // We over-fetch by 10x (capped at 1000) to compensate for filtered-out rows.
    const fetchLimit = Math.min(limit * 10, 1000);
    const rows = await table.query().nearestTo(queryVector).limit(fetchLimit).toArray();

    // Post-filter in JavaScript (avoids SQL case-sensitivity issues with column names)
    const filtered = rows.filter(row => {
      if (language && (row.language as string) !== language) return false;
      if (minFanIn !== undefined && minFanIn > 0 && (row.fanIn as number) < minFanIn) return false;
      return true;
    }).slice(0, limit);

    return filtered.map(row => ({
      record: {
        id: row.id as string,
        name: row.name as string,
        filePath: row.filePath as string,
        className: row.className as string,
        language: row.language as string,
        signature: row.signature as string,
        docstring: row.docstring as string,
        fanIn: row.fanIn as number,
        fanOut: row.fanOut as number,
        isHub: row.isHub as boolean,
        isEntryPoint: row.isEntryPoint as boolean,
        text: row.text as string,
      },
      score: row._distance as number,
    }));
  }

  /**
   * Returns true if a vector index has been built for this output directory.
   */
  static exists(outputDir: string): boolean {
    return existsSync(join(outputDir, DB_FOLDER));
  }
}
