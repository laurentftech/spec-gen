/**
 * Vitest renderer
 * Produces TypeScript test files using the vitest describe/it/expect API.
 */

import type { ParsedScenario } from '../../../types/test-generator.js';
import type { ThenMatch } from '../then-matchers.js';
import { buildMetadataTag, buildRelatedImpl, indent } from './shared.js';

export function renderVitest(
  domain: string,
  requirement: string,
  scenarios: ParsedScenario[],
  matchesByScenario: ThenMatch[][]
): string {
  const blocks: string[] = [];

  blocks.push(`import { describe, it, expect } from "vitest";`);
  blocks.push('');

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    const matches = matchesByScenario[i];

    const tag = buildMetadataTag('//', s);
    const descName = `${titleCase(domain)} / ${s.requirement} / ${s.scenarioName}`;

    const innerLines: string[] = [];

    // G/W/T comments
    for (const g of s.given) innerLines.push(`// GIVEN: ${g}`);
    for (const w of s.when) innerLines.push(`// WHEN: ${w}`);
    for (const t of s.then) innerLines.push(`// THEN: ${t}`);

    // Related implementation
    const relatedImpl = buildRelatedImpl('//', s.mappedFunctions);
    if (relatedImpl.length > 0) {
      innerLines.push('');
      innerLines.push(...relatedImpl);
    }

    innerLines.push('');

    // Assertions
    for (const match of matches) {
      for (const line of match.lines) {
        innerLines.push(line);
      }
    }

    blocks.push(tag);
    blocks.push(`describe("${descName}", () => {`);
    blocks.push(`  it("should satisfy spec scenario", async () => {`);
    blocks.push(...innerLines.map((l) => indent(l, 4)));
    blocks.push(`  });`);
    blocks.push(`});`);
    blocks.push('');
  }

  return blocks.join('\n');
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
