/**
 * Shared utilities for MCP tool handlers.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { LLMContext } from '../../analyzer/artifact-generator.js';
import { ANALYSIS_STALE_THRESHOLD_MS, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../../constants.js';
import { logger } from '../../../utils/logger.js';

/**
 * Resolve and validate a user-supplied directory path.
 *
 * Ensures the path resolves to an existing directory, which prevents path
 * traversal attacks where a client supplies `"../../../../etc"` or a plain
 * file path instead of a project directory.
 */
export async function validateDirectory(directory: string, maxDepth?: number): Promise<string> {
  logger.debug(`Validating directory: ${directory}`);
  return validateDirectoryImpl(directory, maxDepth);
}

export async function validateDirectoryImpl(directory: string, maxDepth?: number): Promise<string> {
  if (!directory || typeof directory !== 'string') {
    logger.warning('Directory validation failed: directory parameter is required and must be a string');
    throw new Error('directory parameter is required and must be a string');
  }
  const absDir = resolve(directory);
  logger.debug(`Resolved directory path: ${absDir}`);

  // Validate directory traversal depth if maxDepth is specified
  if (maxDepth !== undefined) {
    const depth = calculateDirectoryDepth(absDir);
    if (depth > maxDepth) {
      logger.error(`Directory validation failed: Directory depth ${depth} exceeds maximum allowed depth of ${maxDepth}`);
      throw new Error(`Directory depth ${depth} exceeds maximum allowed depth of ${maxDepth}`);
    }
  }

  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(absDir);
  } catch {
    logger.error(`Directory validation failed: Directory not found: ${absDir}`);
    throw new Error(`Directory not found: ${absDir}`);
  }
  if (!s.isDirectory()) {
    logger.error(`Directory validation failed: Not a directory: ${absDir}`);
    throw new Error(`Not a directory: ${absDir}`);
  }
  logger.success(`Successfully validated directory: ${absDir}`);
  return absDir;
}

function calculateDirectoryDepth(path: string): number {
  const normalizedPath = path.replace(/^\\|\\$/g, '');
  const segments = normalizedPath.split(/[\\/]/);
  return segments.length;
}

/**
 * Strip common API key and token patterns from an error message before
 * returning it to MCP clients, to prevent secret leakage via error responses.
 * 
 * @param err - The error to sanitize
 * @param format - Output format: "string" (default) or "json"
 * @returns Sanitized error as string or {message, code} object when format is "json"
 */
export function sanitizeMcpError(err: unknown, format: 'string' | 'json' = 'string'): string | { message: string; code: number } {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const sanitized = rawMessage
    .replace(/sk-ant-[A-Za-z0-9\-_]{10,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9\-_]{20,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S{10,}/g, 'Bearer [REDACTED]')
    .replace(/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]')
    .replace(/api[_-]?key[=:]\s*\S{8,}/gi, 'api_key=[REDACTED]');
  
  if (format === 'json') {
    return { message: sanitized, code: err instanceof Error ? (err as any).code || 500 : 500 };
  }
  
  return sanitized;
}

/**
 * Resolve a user-supplied relative file path against a validated project root
 * and ensure the result stays within that root. Prevents path traversal via
 * `../` sequences.
 */
export function safeJoin(absDir: string, filePath: string): string {
  const resolved = resolve(absDir, filePath);
  if (!resolved.startsWith(absDir + sep) && resolved !== absDir) {
    throw new Error(`Path traversal blocked: "${filePath}" resolves outside project directory`);
  }
  return resolved;
}

export async function readCachedContext(directory: string, timeout?: number): Promise<LLMContext | null> {
  if (timeout !== undefined && timeout > 0) {
    return Promise.race([
      (async () => {
        try {
          const raw = await readFile(
            join(directory, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT),
            'utf-8'
          );
          return JSON.parse(raw) as LLMContext;
        } catch {
          return null;
        }
      })(),
      new Promise<null>((_, reject) => 
        setTimeout(() => reject(new Error(`readCachedContext timed out after ${timeout}ms`)), timeout)
      )
    ]);
  }

  try {
    const raw = await readFile(
      join(directory, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT),
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
    const s = await stat(join(directory, SPEC_GEN_DIR, SPEC_GEN_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT));
    return Date.now() - s.mtimeMs < ANALYSIS_STALE_THRESHOLD_MS;
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
export async function loadMappingIndex(absDir: string, retryCount: number = 1): Promise<MappingIndex | null> {
  const loadAttempt = async (attempt: number): Promise<MappingIndex | null> => {
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
    } catch (error) {
      if (attempt < retryCount && error instanceof Error) {
        const delay = Math.pow(2, attempt) * 100; // Exponential backoff: 200ms, 400ms, 800ms...
        await new Promise(resolve => setTimeout(resolve, delay));
        return loadAttempt(attempt + 1);
      }
      return null;
    }
  };
  
  return loadAttempt(1);
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
