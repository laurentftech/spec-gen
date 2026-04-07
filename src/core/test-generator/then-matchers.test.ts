import { describe, it, expect } from 'vitest';
import { matchThenClauses } from './then-matchers.js';

describe('matchThenClauses', () => {
  // ── Status with error ─────────────────────────────────────────────────────
  describe('pattern: returns status N with error MSG', () => {
    const clause = 'the system returns status 401 with error "Invalid credentials"';

    it('vitest: emits status and error assertions', () => {
      const [match] = matchThenClauses([clause], 'vitest');
      expect(match.fromPattern).toBe(true);
      expect(match.lines).toContain(`expect(response.status).toBe(401);`);
      expect(match.lines).toContain(`expect(response.body.error).toBe('Invalid credentials');`);
    });

    it('pytest: emits status_code and json error assertions', () => {
      const [match] = matchThenClauses([clause], 'pytest');
      expect(match.fromPattern).toBe(true);
      expect(match.lines.join('\n')).toContain('assert response.status_code == 401');
      expect(match.lines.join('\n')).toContain('"error"');
    });

    it('gtest: emits EXPECT_EQ assertions', () => {
      const [match] = matchThenClauses([clause], 'gtest');
      expect(match.fromPattern).toBe(true);
      expect(match.lines.join('\n')).toContain('EXPECT_EQ(response.status, 401)');
    });

    it('catch2: emits REQUIRE assertions', () => {
      const [match] = matchThenClauses([clause], 'catch2');
      expect(match.fromPattern).toBe(true);
      expect(match.lines.join('\n')).toContain('REQUIRE(response.status == 401)');
    });
  });

  // ── Status only ───────────────────────────────────────────────────────────
  describe('pattern: returns status N', () => {
    const clause = 'the system returns status 200';

    it('vitest: emits single status assertion', () => {
      const [match] = matchThenClauses([clause], 'vitest');
      expect(match.fromPattern).toBe(true);
      expect(match.lines).toEqual([`expect(response.status).toBe(200);`]);
    });

    it('playwright: uses status() method', () => {
      const [match] = matchThenClauses([clause], 'playwright');
      expect(match.lines[0]).toContain('response.status()');
    });
  });

  // ── Returns properties ────────────────────────────────────────────────────
  describe('pattern: returns a JWT token, expiry time, and userId', () => {
    const clause = 'the system returns a JWT token, expiry time, and userId with status 200';

    it('vitest: emits toHaveProperty for each key', () => {
      const [match] = matchThenClauses([clause], 'vitest');
      expect(match.fromPattern).toBe(true);
      const joined = match.lines.join('\n');
      expect(joined).toContain("toHaveProperty('token')");
      expect(joined).toContain("toHaveProperty('expiry')");
      expect(joined).toContain("toHaveProperty('userId')");
    });

    it('pytest: emits "in body" assertions', () => {
      const [match] = matchThenClauses([clause], 'pytest');
      const joined = match.lines.join('\n');
      expect(joined).toContain('"token" in body');
    });
  });

  // ── Creates with field value ──────────────────────────────────────────────
  // Note: the clause must have a single keyword before the quoted value
  // ("with status 'todo'" not "with default status 'todo'")
  describe('pattern: creates the task with status "todo"', () => {
    const clause = 'the system creates the task with status "todo"';

    it('vitest: emits field assertion', () => {
      const [match] = matchThenClauses([clause], 'vitest');
      expect(match.fromPattern).toBe(true);
      expect(match.lines.join('\n')).toContain("toBe('todo')");
    });
  });

  // ── No match → placeholder ────────────────────────────────────────────────
  describe('fallback placeholder', () => {
    const clause = 'the system does something completely custom and unusual';

    it('vitest: returns TODO placeholder', () => {
      const [match] = matchThenClauses([clause], 'vitest');
      expect(match.fromPattern).toBe(false);
      expect(match.lines[0]).toContain('TODO');
    });

    it('pytest: returns assert True placeholder', () => {
      const [match] = matchThenClauses([clause], 'pytest');
      expect(match.fromPattern).toBe(false);
      expect(match.lines[0]).toContain('assert True');
    });

    it('gtest: returns SUCCEED() placeholder', () => {
      const [match] = matchThenClauses([clause], 'gtest');
      expect(match.fromPattern).toBe(false);
      expect(match.lines[0]).toContain('SUCCEED()');
    });
  });

  // ── Multiple THEN clauses ─────────────────────────────────────────────────
  it('handles multiple THEN clauses independently', () => {
    const clauses = [
      'the system returns status 200',
      'the system returns a JWT token',
    ];
    const matches = matchThenClauses(clauses, 'vitest');
    expect(matches).toHaveLength(2);
    expect(matches[0].thenIndex).toBe(0);
    expect(matches[1].thenIndex).toBe(1);
    expect(matches[0].fromPattern).toBe(true);
    expect(matches[1].fromPattern).toBe(true);
  });
});
