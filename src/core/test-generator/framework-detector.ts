/**
 * Framework Detector
 *
 * Auto-detects the test framework used in a project by inspecting
 * well-known configuration files, without any LLM call.
 *
 * Detection order (first match wins):
 *   1. vitest     — package.json has vitest dependency
 *   2. playwright — package.json has @playwright/test dependency
 *   3. pytest     — pyproject.toml, setup.cfg, or pytest.ini exists
 *   4. gtest      — CMakeLists.txt contains GTest or googletest
 *   5. catch2     — CMakeLists.txt contains Catch2, or catch2 header exists
 *   → falls back to 'vitest' when nothing is detected
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import type { TestFramework } from '../../types/test-generator.js';

export async function detectFramework(rootPath: string): Promise<TestFramework> {
  // ── 1. Check package.json for JS/TS frameworks ──────────────────────────
  const pkgPath = join(rootPath, 'package.json');
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      const allDeps: Record<string, string> = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if ('vitest' in allDeps) return 'vitest';
      if ('@playwright/test' in allDeps) return 'playwright';
    } catch {
      // Malformed package.json — continue to next check
    }
  }

  // ── 2. Check for Python pytest ───────────────────────────────────────────
  const pythonMarkers = [
    join(rootPath, 'pyproject.toml'),
    join(rootPath, 'setup.cfg'),
    join(rootPath, 'pytest.ini'),
    join(rootPath, 'setup.py'),
  ];
  for (const marker of pythonMarkers) {
    if (await fileExists(marker)) return 'pytest';
  }

  // ── 3. Check CMakeLists.txt for C++ frameworks ───────────────────────────
  const cmakePath = join(rootPath, 'CMakeLists.txt');
  if (await fileExists(cmakePath)) {
    try {
      const cmake = await readFile(cmakePath, 'utf-8');
      if (/\bCatch2\b/i.test(cmake)) return 'catch2';
      if (/\bgoogletest\b|\bGTest\b/i.test(cmake)) return 'gtest';
    } catch {
      // ignore
    }
  }

  // ── 4. Default ───────────────────────────────────────────────────────────
  return 'vitest';
}
