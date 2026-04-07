/**
 * Catch2 renderer
 * Produces C++ test files using the Catch2 v3 TEST_CASE macro style.
 */

import type { ParsedScenario } from '../../../types/test-generator.js';
import type { ThenMatch } from '../then-matchers.js';
import { buildMetadataTag, buildRelatedImpl, toPascalCase } from './shared.js';

export function renderCatch2(
  domain: string,
  requirement: string,
  scenarios: ParsedScenario[],
  matchesByScenario: ThenMatch[][]
): string {
  const blocks: string[] = [];

  blocks.push('#include <catch2/catch_test_macros.hpp>');
  blocks.push('');

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const matches = matchesByScenario[i];

    const tag = buildMetadataTag('//', s);
    const caseName = `${domain} / ${requirement} / ${s.scenarioName}`;
    const tags = `[${domain}][spec-gen]`;

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
    blocks.push(`TEST_CASE("${caseName}", "${tags}") {`);
    blocks.push(...innerLines.map((l) => `    ${l}`));
    blocks.push('}');
    blocks.push('');
  }

  return blocks.join('\n');
}

// suppress unused import warning
void toPascalCase;
