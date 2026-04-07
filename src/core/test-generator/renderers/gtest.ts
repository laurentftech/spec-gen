/**
 * Google Test renderer
 * Produces C++ test files using the Google Test (GTest) framework.
 */

import type { ParsedScenario } from '../../../types/test-generator.js';
import type { ThenMatch } from '../then-matchers.js';
import { buildMetadataTag, buildRelatedImpl, toPascalCase } from './shared.js';

export function renderGtest(
  domain: string,
  requirement: string,
  scenarios: ParsedScenario[],
  matchesByScenario: ThenMatch[][]
): string {
  const blocks: string[] = [];

  blocks.push('#include <gtest/gtest.h>');
  blocks.push('');

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const matches = matchesByScenario[i];

    const tag = buildMetadataTag('//', s);
    const suiteName = `${toPascalCase(domain)}_${toPascalCase(requirement)}`;
    const testName = toPascalCase(s.scenarioName);

    const innerLines: string[] = [];
    for (const g of s.given) innerLines.push(`// GIVEN: ${g}`);
    for (const w of s.when) innerLines.push(`// WHEN: ${w}`);
    for (const t of s.then) innerLines.push(`// THEN: ${t}`);

    const relatedImpl = buildRelatedImpl('//', s.mappedFunctions);
    if (relatedImpl.length > 0) {
      innerLines.push('');
      innerLines.push(...relatedImpl);
    }

    innerLines.push('');
    for (const match of matches) {
      for (const line of match.lines) {
        innerLines.push(line);
      }
    }

    blocks.push(tag);
    blocks.push(`TEST(${suiteName}, ${testName}) {`);
    blocks.push(...innerLines.map((l) => `    ${l}`));
    blocks.push('}');
    blocks.push('');
  }

  return blocks.join('\n');
}
