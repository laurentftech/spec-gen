/**
 * Maps drift results to the test files that cover the affected domains.
 * Scans test files for // openlore: {JSON} metadata tags (written by openlore test).
 * No LLM required.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import type { DriftResult } from '../../types/index.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DomainTestSuggestion {
  domain: string;
  testFiles: string[];
  scenarioCount: number;
}

export interface TestSuggestion {
  domains: DomainTestSuggestion[];
  /** Flat list of all unique test files for easy copy-paste into a test runner */
  allFiles: string[];
}

// ============================================================================
// INTERNALS
// ============================================================================

const TEST_FILE_EXTENSIONS = /\.(spec|test)\.[tj]sx?$|_test\.(py|cpp|cc)$|^test_.*\.py$/;
const TAG_REGEX = /(?:\/\/|#)\s*openlore:\s*(\{[^\n]+\})/g;

async function walkTestFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  if (!(await fileExists(dir))) return results;

  async function walk(current: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(current); } catch { return; }

    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', 'build'].includes(entry)) continue;
      const full = join(current, entry);
      if (TEST_FILE_EXTENSIONS.test(entry)) {
        results.push(full);
      } else if (!entry.includes('.')) {
        await walk(full);
      }
    }
  }

  await walk(dir);
  return results;
}

async function scanDomainTags(absPath: string): Promise<string[]> {
  let content: string;
  try { content = await readFile(absPath, 'utf-8'); } catch { return []; }

  const domains = new Set<string>();
  TAG_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_REGEX.exec(content)) !== null) {
    try {
      const tag = JSON.parse(m[1]);
      if (typeof tag.domain === 'string') domains.add(tag.domain.toLowerCase());
    } catch { /* malformed tag */ }
  }
  return [...domains];
}

// ============================================================================
// MAIN
// ============================================================================

export async function suggestTestsForDrift(
  driftResult: DriftResult,
  rootPath: string,
  testDirs = ['spec-tests', 'src'],
): Promise<TestSuggestion> {
  const absRoot = resolve(rootPath);

  // Extract the set of drifted domains from the drift result
  const driftedDomains = new Set(
    driftResult.issues
      .map((i) => i.domain)
      .filter((d): d is string => typeof d === 'string' && d.length > 0)
      .map((d) => d.toLowerCase())
  );

  if (driftedDomains.size === 0) {
    return { domains: [], allFiles: [] };
  }

  // Walk test directories and collect all test files
  const allTestFiles: string[] = [];
  for (const dir of testDirs) {
    const absDir = join(absRoot, dir);
    allTestFiles.push(...(await walkTestFiles(absDir)));
  }

  // For each test file, check which domains it covers
  const filesByDomain = new Map<string, Set<string>>();
  const scenarioCountByDomain = new Map<string, number>();

  await Promise.all(
    allTestFiles.map(async (absPath) => {
      const coveredDomains = await scanDomainTags(absPath);
      const relPath = absPath.replace(absRoot + '/', '');

      for (const domain of coveredDomains) {
        if (!driftedDomains.has(domain)) continue;
        if (!filesByDomain.has(domain)) filesByDomain.set(domain, new Set());
        filesByDomain.get(domain)!.add(relPath);
        scenarioCountByDomain.set(domain, (scenarioCountByDomain.get(domain) ?? 0) + 1);
      }
    })
  );

  // Build result, ordered by domain name
  const domains: DomainTestSuggestion[] = [...filesByDomain.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, files]) => ({
      domain,
      testFiles: [...files].sort(),
      scenarioCount: scenarioCountByDomain.get(domain) ?? 0,
    }));

  const allFiles = [...new Set(domains.flatMap((d) => d.testFiles))];

  return { domains, allFiles };
}
