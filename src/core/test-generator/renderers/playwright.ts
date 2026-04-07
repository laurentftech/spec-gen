/**
 * Playwright renderer
 * Produces TypeScript test files using the @playwright/test API.
 */

import type { ParsedScenario } from '../../../types/test-generator.js';
import type { ThenMatch } from '../then-matchers.js';
import { buildMetadataTag, buildRelatedImpl, indent } from './shared.js';

export function renderPlaywright(
  _domain: string,
  _requirement: string,
  scenarios: ParsedScenario[],
  matchesByScenario: ThenMatch[][]
): string {
  const blocks: string[] = [];

  blocks.push(`import { test, expect } from "@playwright/test";`);
  blocks.push('');

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const matches = matchesByScenario[i];

    const tag = buildMetadataTag('//', s);
    const testName = `${s.domain} / ${s.requirement} / ${s.scenarioName}`;

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
    blocks.push(`test("${testName}", async ({ page }) => {`);
    blocks.push(...innerLines.map((l) => indent(l, 2)));
    blocks.push(`});`);
    blocks.push('');
  }

  return blocks.join('\n');
}
