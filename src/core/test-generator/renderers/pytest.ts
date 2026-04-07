/**
 * pytest renderer
 * Produces Python test files using the pytest class-based style.
 */

import type { ParsedScenario } from '../../../types/test-generator.js';
import type { ThenMatch } from '../then-matchers.js';
import { buildMetadataTag, buildRelatedImpl, toSnakeCase } from './shared.js';

export function renderPytest(
  _domain: string,
  _requirement: string,
  scenarios: ParsedScenario[],
  matchesByScenario: ThenMatch[][]
): string {
  const blocks: string[] = [];

  blocks.push('import pytest');
  blocks.push('');

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const matches = matchesByScenario[i];

    const tag = buildMetadataTag('#', s);
    const className = `Test${s.domain.charAt(0).toUpperCase() + s.domain.slice(1)}${s.requirement}${s.scenarioName}`;

    const methodLines: string[] = [];
    for (const g of s.given) methodLines.push(`# GIVEN: ${g}`);
    for (const w of s.when) methodLines.push(`# WHEN: ${w}`);
    for (const t of s.then) methodLines.push(`# THEN: ${t}`);

    const relatedImpl = buildRelatedImpl('#', s.mappedFunctions);
    if (relatedImpl.length > 0) {
      methodLines.push('');
      methodLines.push(...relatedImpl);
    }

    methodLines.push('');
    for (const match of matches) {
      for (const line of match.lines) {
        methodLines.push(line);
      }
    }

    blocks.push(tag);
    blocks.push(`class ${className}:`);
    blocks.push(`    def test_${toSnakeCase(s.scenarioName)}(self):`);
    blocks.push(...methodLines.map((l) => `        ${l}`));
    blocks.push('');
  }

  return blocks.join('\n');
}
