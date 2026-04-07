/**
 * THEN Clause Pattern Engine
 *
 * Transforms natural-language THEN clauses from OpenSpec scenarios into
 * framework-specific assertion lines — without any LLM call.
 *
 * Design principles:
 *   - Pure functions only, no I/O
 *   - Each pattern matches a common spec phrase and emits assertions
 *   - Multiple assertions can be emitted per THEN line
 *   - Falls back to a TODO placeholder when no pattern matches
 *   - Framework-aware: same pattern emits different syntax per framework
 *
 * Adding a new pattern:
 *   1. Add a ThenPattern to PATTERNS below
 *   2. Add assertions for all five frameworks in its `assertions` object
 */

import type { TestFramework } from '../../types/test-generator.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ThenMatch {
  /** Assertion source lines for the given framework */
  lines: string[];
  /** Which THEN clause index this matched */
  thenIndex: number;
  /** true = came from pattern engine; false = placeholder */
  fromPattern: boolean;
}

type AssertionBuilder = (m: RegExpMatchArray) => string[];

interface ThenPattern {
  /** Regex to match against the THEN clause text */
  regex: RegExp;
  /** Per-framework assertion builders */
  assertions: Record<TestFramework, AssertionBuilder>;
}

// ============================================================================
// PATTERN LIBRARY
// ============================================================================

const PATTERNS: ThenPattern[] = [
  // ── "returns status <N> with error '<msg>'" ──────────────────────────────
  {
    regex: /returns?\s+status\s+(\d+)\s+with\s+error\s+["']([^"']+)["']/i,
    assertions: {
      vitest: ([, status, msg]) => [
        `expect(response.status).toBe(${status});`,
        `expect(response.body.error).toBe('${msg}');`,
      ],
      playwright: ([, status, msg]) => [
        `expect(response.status()).toBe(${status});`,
        `expect(await response.json()).toMatchObject({ error: '${msg}' });`,
      ],
      pytest: ([, status, msg]) => [
        `assert response.status_code == ${status}`,
        `assert response.json()["error"] == "${msg}"`,
      ],
      gtest: ([, status, msg]) => [
        `EXPECT_EQ(response.status, ${status});`,
        `EXPECT_EQ(response.body["error"], "${msg}");`,
      ],
      catch2: ([, status, msg]) => [
        `REQUIRE(response.status == ${status});`,
        `REQUIRE(response.body["error"] == "${msg}");`,
      ],
    },
  },

  // ── "returns status <N>" ─────────────────────────────────────────────────
  {
    regex: /returns?\s+status\s+(\d+)/i,
    assertions: {
      vitest: ([, status]) => [`expect(response.status).toBe(${status});`],
      playwright: ([, status]) => [`expect(response.status()).toBe(${status});`],
      pytest: ([, status]) => [`assert response.status_code == ${status}`],
      gtest: ([, status]) => [`EXPECT_EQ(response.status, ${status});`],
      catch2: ([, status]) => [`REQUIRE(response.status == ${status});`],
    },
  },

  // ── "returns a/an <prop> [, <prop>] [and <prop>]" ────────────────────────
  // e.g. "returns a JWT token, expiry time, and userId"
  {
    regex: /returns?\s+(?:a|an)\s+(.+?)(?:\s+with\s+status\s+\d+)?$/i,
    assertions: {
      vitest: ([, propsStr]) => extractProps(propsStr).map(
        (p) => `expect(response.body).toHaveProperty('${p}');`
      ),
      playwright: ([, propsStr]) => [
        `const body = await response.json();`,
        ...extractProps(propsStr).map((p) => `expect(body).toHaveProperty('${p}');`),
      ],
      pytest: ([, propsStr]) => [
        `body = response.json()`,
        ...extractProps(propsStr).map((p) => `assert "${p}" in body`),
      ],
      gtest: ([, propsStr]) => extractProps(propsStr).map(
        (p) => `EXPECT_TRUE(response.body.contains("${p}"));`
      ),
      catch2: ([, propsStr]) => extractProps(propsStr).map(
        (p) => `REQUIRE(response.body.contains("${p}"));`
      ),
    },
  },

  // ── "creates/creates the <entity> with <field> '<value>'" ─────────────────
  {
    regex: /creates?\s+(?:the\s+)?\w+\s+with\s+(\w+)\s+["']([^"']+)["']/i,
    assertions: {
      vitest: ([, field, value]) => [
        `expect(result.${field}).toBe('${value}');`,
      ],
      playwright: ([, field, value]) => [
        `const result = await response.json();`,
        `expect(result.${field}).toBe('${value}');`,
      ],
      pytest: ([, field, value]) => [
        `result = response.json()`,
        `assert result["${field}"] == "${value}"`,
      ],
      gtest: ([, field, value]) => [
        `EXPECT_EQ(result.${field}, "${value}");`,
      ],
      catch2: ([, field, value]) => [
        `REQUIRE(result.${field} == "${value}");`,
      ],
    },
  },

  // ── "returns the <entity> with status <N>" ───────────────────────────────
  {
    regex: /returns?\s+(?:the\s+)?\w+\s+(?:and\s+)?\w*\s*with\s+status\s+(\d+)/i,
    assertions: {
      vitest: ([, status]) => [
        `expect(response.status).toBe(${status});`,
        `expect(response.body).toBeDefined();`,
      ],
      playwright: ([, status]) => [
        `expect(response.status()).toBe(${status});`,
      ],
      pytest: ([, status]) => [
        `assert response.status_code == ${status}`,
        `assert response.json() is not None`,
      ],
      gtest: ([, status]) => [
        `EXPECT_EQ(response.status, ${status});`,
        `EXPECT_FALSE(response.body.empty());`,
      ],
      catch2: ([, status]) => [
        `REQUIRE(response.status == ${status});`,
        `REQUIRE(!response.body.empty());`,
      ],
    },
  },

  // ── "throws/raises an error" ─────────────────────────────────────────────
  {
    regex: /(?:throws?|raises?)\s+(?:an?\s+)?(?:error|exception)/i,
    assertions: {
      vitest: () => [`await expect(action()).rejects.toThrow();`],
      playwright: () => [`// TODO: verify error is thrown`],
      pytest: () => [`with pytest.raises(Exception):\n        action()`],
      gtest: () => [`EXPECT_THROW(action(), std::exception);`],
      catch2: () => [`REQUIRE_THROWS(action());`],
    },
  },

  // ── "does not/doesn't <verb>" ────────────────────────────────────────────
  {
    regex: /does\s+not|doesn'?t/i,
    assertions: {
      vitest: () => [`expect(result).toBeUndefined(); // TODO: verify negative case`],
      playwright: () => [`// TODO: verify negative behavior`],
      pytest: () => [`assert result is None  # TODO: verify negative case`],
      gtest: () => [`EXPECT_FALSE(result.has_value()); // TODO: verify negative case`],
      catch2: () => [`REQUIRE_FALSE(result.has_value()); // TODO: verify negative case`],
    },
  },
];

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Extract property names from a "a JWT token, expiry time, and userId" string.
 * Strips filler words (a/an/the/time/etc.) to get clean property identifiers.
 */
function extractProps(raw: string): string[] {
  // Remove "and", split on comma
  const parts = raw
    .replace(/\band\b/gi, ',')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.map((p) => {
    // Take the last "word" in each part as the property name — usually correct
    // "JWT token" → "token", "expiry time" → "expiry", "userId" → "userId"
    const words = p.replace(/[^a-zA-Z0-9\s_]/g, '').trim().split(/\s+/);
    // If last word is a filler, take the one before it
    const fillers = new Set(['time', 'date', 'value', 'object', 'item', 'entity']);
    if (words.length > 1 && fillers.has(words[words.length - 1].toLowerCase())) {
      return words[words.length - 2];
    }
    return words[words.length - 1];
  }).filter(Boolean);
}

// ============================================================================
// PUBLIC API
// ============================================================================

const PLACEHOLDER: Record<TestFramework, string> = {
  vitest: `expect(true).toBe(true); // TODO: implement assertion`,
  playwright: `// TODO: implement assertion`,
  pytest: `assert True  # TODO: implement assertion`,
  gtest: `SUCCEED(); // TODO: implement assertion`,
  catch2: `SUCCEED(); // TODO: implement assertion`,
};

/**
 * Match THEN clauses against the pattern library and return assertion lines.
 *
 * @param thenClauses  Array of THEN clause strings (one per bullet)
 * @param framework    Target test framework
 * @returns            Array of ThenMatch — one per THEN clause
 */
export function matchThenClauses(
  thenClauses: string[],
  framework: TestFramework
): ThenMatch[] {
  return thenClauses.map((clause, thenIndex) => {
    for (const pattern of PATTERNS) {
      const m = clause.match(pattern.regex);
      if (m) {
        const builder = pattern.assertions[framework];
        const lines = builder(m);
        if (lines.length > 0) {
          return { lines, thenIndex, fromPattern: true };
        }
      }
    }
    // No pattern matched — emit placeholder
    return {
      lines: [PLACEHOLDER[framework]],
      thenIndex,
      fromPattern: false,
    };
  });
}
