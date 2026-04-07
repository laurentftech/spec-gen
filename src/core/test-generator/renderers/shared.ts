/**
 * Shared helpers for all framework renderers.
 */

import type { ParsedScenario, FunctionRef } from '../../../types/test-generator.js';

/** Build the // spec-gen: JSON metadata tag */
export function buildMetadataTag(
  commentPrefix: string,
  s: ParsedScenario
): string {
  const tag = JSON.stringify({
    domain: s.domain,
    requirement: s.requirement,
    scenario: s.scenarioName,
    specFile: s.specFile,
  });
  return `${commentPrefix} spec-gen: ${tag}`;
}

/** Build "RELATED IMPLEMENTATION:" comment block */
export function buildRelatedImpl(
  commentPrefix: string,
  functions: FunctionRef[]
): string[] {
  const visible = functions
    .filter((f) => f.confidence !== 'heuristic' || functions.length <= 2)
    .slice(0, 5);
  if (visible.length === 0) return [];

  const lines: string[] = [`${commentPrefix} RELATED IMPLEMENTATION:`];
  for (const fn of visible) {
    const conf = fn.confidence;
    lines.push(`${commentPrefix} - ${fn.file}: ${fn.name}() [${conf}]`);
  }
  return lines;
}

/** Indent each non-empty line by `n` spaces */
export function indent(line: string, n: number): string {
  if (!line.trim()) return '';
  return ' '.repeat(n) + line;
}

/** Convert a string to a Python/file-system friendly snake_case slug */
export function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .toLowerCase();
}

/** Convert to CamelCase (for C++ test names etc.) */
export function toPascalCase(s: string): string {
  return s
    .replace(/[_\-\s]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (c) => c.toUpperCase());
}
