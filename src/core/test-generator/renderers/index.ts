/**
 * Framework renderer dispatcher
 *
 * Calls the correct renderer for a given TestFramework and returns
 * the fully rendered file content as a string.
 */

import type { ParsedScenario, TestFramework } from '../../../types/test-generator.js';
import type { ThenMatch } from '../then-matchers.js';
import { renderVitest } from './vitest.js';
import { renderPlaywright } from './playwright.js';
import { renderPytest } from './pytest.js';
import { renderGtest } from './gtest.js';
import { renderCatch2 } from './catch2.js';

export { renderVitest, renderPlaywright, renderPytest, renderGtest, renderCatch2 };

/**
 * Render a set of scenarios (all belonging to the same domain + requirement)
 * into a test file string for the given framework.
 */
export function renderTests(
  framework: TestFramework,
  domain: string,
  requirement: string,
  scenarios: ParsedScenario[],
  matchesByScenario: ThenMatch[][]
): string {
  switch (framework) {
    case 'vitest':
      return renderVitest(domain, requirement, scenarios, matchesByScenario);
    case 'playwright':
      return renderPlaywright(domain, requirement, scenarios, matchesByScenario);
    case 'pytest':
      return renderPytest(domain, requirement, scenarios, matchesByScenario);
    case 'gtest':
      return renderGtest(domain, requirement, scenarios, matchesByScenario);
    case 'catch2':
      return renderCatch2(domain, requirement, scenarios, matchesByScenario);
    default: {
      const _never: never = framework;
      throw new Error(`Unknown framework: ${String(_never)}`);
    }
  }
}
