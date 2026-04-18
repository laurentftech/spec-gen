/**
 * Miscellaneous utilities
 * Shared helpers that don't belong in other specific modules.
 */

/**
 * Parse JSON from LLM output, handling markdown code fences.
 * Strips ``` fences, extracts JSON array or object, returns fallback on failure.
 */
export function parseJSON<T>(text: string, fallback: T): T {
  const stripped = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '');
  const match = stripped.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!match) return fallback;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return fallback;
  }
}