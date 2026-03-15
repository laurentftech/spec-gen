/**
 * CppHeaderResolver — maps C++ #include directives to implementation files.
 *
 * In C++ a caller in main.cpp that does `#include "engine.h"` effectively
 * has access to all symbols defined in engine.cpp (the paired implementation).
 * This module builds that header→impl mapping so that the call graph resolver
 * can prefer the correct .cpp file when resolving cross-file calls.
 */

import { dirname, resolve } from 'node:path';

const SYSTEM_HEADERS = new Set([
  'iostream', 'vector', 'string', 'map', 'set', 'unordered_map',
  'memory', 'algorithm', 'functional', 'utility', 'stdexcept',
  'cassert', 'cmath', 'cstdlib', 'cstring', 'thread', 'mutex',
]);

export interface CppInclude {
  headerPath: string;
  isRelative: boolean;
  isSystem: boolean;
}

/** Parse #include directives from a C++ source file. */
export function parseCppIncludes(
  filePath: string,
  content: string,
  _allFilePaths: string[],
): CppInclude[] {
  const result: CppInclude[] = [];
  const dir = dirname(filePath);

  // #include "relative/path.h"
  for (const m of content.matchAll(/#include\s+"([^"]+)"/g)) {
    result.push({ headerPath: resolve(dir, m[1]), isRelative: true, isSystem: false });
  }

  // #include <system_header>
  for (const m of content.matchAll(/#include\s+<([^>]+)>/g)) {
    const name = m[1].split('/')[0];
    result.push({ headerPath: m[1], isRelative: false, isSystem: SYSTEM_HEADERS.has(name) });
  }

  return result;
}

/**
 * Build a map from header path → implementation file path.
 * Convention: foo.h and foo.cpp (or .cc) in the same directory are paired.
 */
export function buildHeaderToImplMap(allFilePaths: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cpp of allFilePaths.filter(f => /\.(cpp|cc|cxx)$/.test(f))) {
    const base = cpp.replace(/\.(cpp|cc|cxx)$/, '');
    for (const ext of ['.h', '.hpp']) {
      const header = base + ext;
      if (allFilePaths.includes(header)) map.set(header, cpp);
    }
  }
  return map;
}

/**
 * Build a map from C++ source file → Set of implementation files reachable
 * via its #include directives.  Used during call resolution to prefer the
 * implementation file that matches an #include in the caller.
 */
export function buildCppImportMap(
  files: Array<{ path: string; content: string }>,
  allFilePaths: string[],
): Map<string, Set<string>> {
  const headerToImpl = buildHeaderToImplMap(allFilePaths);
  const result = new Map<string, Set<string>>();

  for (const file of files) {
    if (!/\.(cpp|cc|cxx|h|hpp)$/.test(file.path)) continue;
    const includes = parseCppIncludes(file.path, file.content, allFilePaths);
    const accessible = new Set<string>();
    for (const inc of includes) {
      if (inc.isSystem) continue;
      const impl = headerToImpl.get(inc.headerPath);
      if (impl) accessible.add(impl);
    }
    if (accessible.size > 0) result.set(file.path, accessible);
  }

  return result;
}
