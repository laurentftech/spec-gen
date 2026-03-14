/**
 * Shared utilities for MCP tool handlers.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { LLMContext } from '../../analyzer/artifact-generator.js';

/**
 * Resolve and validate a user-supplied directory path.
 *
 * Ensures the path resolves to an existing directory, which prevents path
 * traversal attacks where a client supplies `"../../../../etc"` or a plain
 * file path instead of a project directory.
 */
export async function validateDirectory(directory: string): Promise<string> {
  if (!directory || typeof directory !== 'string') {
    throw new Error('directory parameter is required and must be a string');
  }
  const absDir = resolve(directory);
  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(absDir);
  } catch {
    throw new Error(`Directory not found: ${absDir}`);
  }
  if (!s.isDirectory()) {
    throw new Error(`Not a directory: ${absDir}`);
  }
  return absDir;
}

/**
 * Strip common API key and token patterns from an error message before
 * returning it to MCP clients, to prevent secret leakage via error responses.
 */
export function sanitizeMcpError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/sk-ant-[A-Za-z0-9\-_]{10,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9\-_]{20,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S{10,}/g, 'Bearer [REDACTED]')
    .replace(/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]')
    .replace(/api[_-]?key[=:]\s*\S{8,}/gi, 'api_key=[REDACTED]');
}

export async function readCachedContext(directory: string): Promise<LLMContext | null> {
  try {
    const raw = await readFile(
      join(directory, '.spec-gen', 'analysis', 'llm-context.json'),
      'utf-8'
    );
    return JSON.parse(raw) as LLMContext;
  } catch {
    return null;
  }
}

/** Returns true if the cached analysis is present and less than 1 hour old. */
export async function isCacheFresh(directory: string): Promise<boolean> {
  try {
    const s = await stat(join(directory, '.spec-gen', 'analysis', 'llm-context.json'));
    return Date.now() - s.mtimeMs < 60 * 60 * 1000;
  } catch {
    return false;
  }
}

// ============================================================================
// BIDIRECTIONAL CODE ↔ SPEC LINKING (#4)
// ============================================================================

export interface MappingEntry {
  requirement: string;
  service: string;
  domain: string;
  specFile: string;
  functions: Array<{ name: string; file: string; line: number; kind: string; confidence: string }>;
}

export interface MappingIndex {
  /** filePath → list of mapping entries that reference it */
  byFile: Map<string, MappingEntry[]>;
  /** domain → list of mapping entries for that domain */
  byDomain: Map<string, MappingEntry[]>;
  entries: MappingEntry[];
}

/** Load and index mapping.json for bidirectional lookup. Returns null if not found. */
export async function loadMappingIndex(absDir: string): Promise<MappingIndex | null> {
  try {
    const raw = await readFile(join(absDir, '.spec-gen', 'analysis', 'mapping.json'), 'utf-8');
    const data = JSON.parse(raw) as { mappings: MappingEntry[] };
    const entries = data.mappings ?? [];

    const byFile = new Map<string, MappingEntry[]>();
    const byDomain = new Map<string, MappingEntry[]>();

    for (const entry of entries) {
      // index by domain
      const domainList = byDomain.get(entry.domain) ?? [];
      domainList.push(entry);
      byDomain.set(entry.domain, domainList);

      // index by each referenced file
      for (const fn of entry.functions) {
        if (!fn.file || fn.file === '*') continue;
        const fileList = byFile.get(fn.file) ?? [];
        // avoid duplicates (same requirement may appear multiple times per file)
        if (!fileList.includes(entry)) fileList.push(entry);
        byFile.set(fn.file, fileList);
      }
    }

    return { byFile, byDomain, entries };
  } catch {
    return null;
  }
}

/** Summarise which specs cover a given file path (for search_code enrichment). */
export function specsForFile(index: MappingIndex, filePath: string): Array<{ requirement: string; domain: string; specFile: string }> {
  const entries = index.byFile.get(filePath) ?? [];
  // deduplicate by requirement
  const seen = new Set<string>();
  return entries
    .filter(e => { const k = `${e.domain}::${e.requirement}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(e => ({ requirement: e.requirement, domain: e.domain, specFile: e.specFile }));
}

/** Return functions that implement a given domain/specFile (for search_specs enrichment). */
export function functionsForDomain(index: MappingIndex, domain: string): Array<{ name: string; file: string; line: number; kind: string; confidence: string; requirement: string }> {
  const entries = index.byDomain.get(domain) ?? [];
  const result: Array<{ name: string; file: string; line: number; kind: string; confidence: string; requirement: string }> = [];
  for (const entry of entries) {
    for (const fn of entry.functions) {
      if (fn.name === '*') continue;
      result.push({ ...fn, requirement: entry.requirement });
    }
  }
  return result;
}
