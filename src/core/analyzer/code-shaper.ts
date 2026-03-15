/**
 * Code Shaper — skeleton extraction for large/complex functions.
 *
 * Strips implementation noise (logging, inline comments, blank lines)
 * while preserving the logical skeleton:
 *   - function/class/method signatures
 *   - control flow: if/else, switch, for/while, try/catch
 *   - return and throw statements
 *   - call expressions and variable declarations
 *
 * Complementary to the call-graph subgraph extractor:
 *   - subgraph gives TOPOLOGY (who calls whom)
 *   - skeleton gives INTERNAL STRUCTURE (how the orchestrator is sequenced)
 *
 * Works on raw source text without tree-sitter, covering all supported languages.
 */

// ============================================================================
// LOG PATTERNS PER LANGUAGE
// ============================================================================

const LOG_PATTERNS_COMMON = [
  /^console\.(log|warn|error|debug|info|trace)\s*\(/,
  /^logger\.(debug|info|warn|warning|error|critical|trace)\s*\(/,
  /^this\.logger\.(debug|info|warn|warning|error|critical)\s*\(/,
  /^self\.logger\.(debug|info|warn|warning|error|critical)\s*\(/,
  /^log\.(debug|info|warn|warning|error)\s*\(/,
];

const LOG_PATTERNS_BY_LANGUAGE: Record<string, RegExp[]> = {
  Python: [
    ...LOG_PATTERNS_COMMON,
    /^print\s*\(/,
    /^logging\.(debug|info|warn|warning|error|critical)\s*\(/,
  ],
  Java: [
    ...LOG_PATTERNS_COMMON,
    /^System\.out\.print/,
    /^LOGGER\.(debug|info|warn|error)\s*\(/,
    /^LOG\.(debug|info|warn|error)\s*\(/,
  ],
  Go: [
    ...LOG_PATTERNS_COMMON,
    /^fmt\.(Print|Println|Printf)\s*\(/,
    /^log\.(Print|Println|Printf|Fatal|Fatalf|Panic)\s*\(/,
  ],
};

function getLogPatterns(language: string): RegExp[] {
  return LOG_PATTERNS_BY_LANGUAGE[language] ?? LOG_PATTERNS_COMMON;
}

// ============================================================================
// SKELETON EXTRACTION
// ============================================================================

/**
 * Strip implementation noise from source code.
 *
 * Returns a skeleton that preserves structure (signatures, control flow,
 * calls, returns) while removing logs and non-docstring comments.
 *
 * The returned skeleton is always shorter than or equal to the original.
 */
export function getSkeletonContent(source: string, language: string): string {
  const lines = source.split('\n');
  const result: string[] = [];
  const logPatterns = getLogPatterns(language);

  // State machine for block comments
  let inJsDoc = false;    // /** ... */ — keep
  let inBlockComment = false; // /* ... */  — strip
  let consecutiveBlanks = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // ── Block comment state transitions ──────────────────────────────────

    if (!inJsDoc && !inBlockComment) {
      if (trimmed.startsWith('/**')) {
        inJsDoc = true;
        result.push(line);
        if (trimmed.includes('*/')) inJsDoc = false;
        continue;
      }
      if (trimmed.startsWith('/*')) {
        inBlockComment = true;
        if (trimmed.includes('*/')) inBlockComment = false;
        continue; // strip non-JSDoc block comments
      }
    }

    if (inJsDoc) {
      result.push(line);
      if (trimmed.includes('*/')) inJsDoc = false;
      continue;
    }

    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue; // strip
    }

    // ── Single-line comment stripping ─────────────────────────────────────
    // Strip pure comment lines; keep code lines that have trailing comments
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
      continue;
    }

    // ── Log statement stripping ───────────────────────────────────────────
    if (logPatterns.some(p => p.test(trimmed))) {
      continue;
    }

    // ── Blank line collapsing ─────────────────────────────────────────────
    if (trimmed === '') {
      consecutiveBlanks++;
      if (consecutiveBlanks <= 1) result.push('');
      continue;
    }
    consecutiveBlanks = 0;

    result.push(line);
  }

  return result.join('\n').trim();
}

// ============================================================================
// LANGUAGE DETECTION
// ============================================================================

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  rb: 'Ruby',
  java: 'Java',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  h: 'C++',
  hpp: 'C++',
};

export function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANGUAGE[ext] ?? 'unknown';
}

// ============================================================================
// REDUCTION RATIO
// ============================================================================

/**
 * Returns true when the skeleton achieves a meaningful size reduction
 * (at least 20% smaller than the original).
 * Used to decide whether including the skeleton is worth the token cost.
 */
export function isSkeletonWorthIncluding(original: string, skeleton: string): boolean {
  if (original.length === 0) return false;
  return skeleton.length / original.length < 0.8;
}
