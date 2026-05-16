/**
 * Tests for the epistemic lease — session-level architectural confidence decay.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTracker, updateTracker, injectFreshness } from './epistemic-lease.js';
import type { EpistemicTracker } from './epistemic-lease.js';

// ============================================================================
// Mock git hash — default returns stable hash
// ============================================================================

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ stdout: 'deadbeef1234\n', status: 0 })),
}));

import { spawnSync } from 'node:child_process';
const mockSpawnSync = vi.mocked(spawnSync);

// ============================================================================
// HELPERS
// ============================================================================

function freshTracker(): EpistemicTracker {
  return createTracker('/fake/repo');
}

// ============================================================================
// createTracker
// ============================================================================

describe('createTracker', () => {
  it('starts fresh with zero load', () => {
    const t = freshTracker();
    expect(t.freshnessState).toBe('fresh');
    expect(t.cognitiveLoad).toBe(0);
    expect(t.modulesVisited.size).toBe(0);
  });

  it('captures git hash at creation', () => {
    mockSpawnSync.mockReturnValueOnce({ stdout: 'abc123\n', status: 0 } as ReturnType<typeof spawnSync>);
    const t = createTracker('/fake/repo');
    expect(t.graphVersionAtOrient).toBe('abc123');
  });

  it('handles git unavailable gracefully', () => {
    mockSpawnSync.mockReturnValueOnce({ stdout: null, status: 128 } as unknown as ReturnType<typeof spawnSync>);
    const t = createTracker('/fake/repo');
    expect(t.graphVersionAtOrient).toBe('');
    expect(t.freshnessState).toBe('fresh');
  });
});

// ============================================================================
// updateTracker — orient resets
// ============================================================================

describe('updateTracker — orient reset', () => {
  it('resets load, modules, and state to fresh', () => {
    const t = freshTracker();
    // Manually degrade
    t.cognitiveLoad = 50;
    t.freshnessState = 'degraded';
    t.modulesVisited.add('auth');

    updateTracker(t, 'orient', '/fake/repo');

    expect(t.freshnessState).toBe('fresh');
    expect(t.cognitiveLoad).toBe(0);
    expect(t.modulesVisited.size).toBe(0);
  });

  it('updates git hash on orient reset', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = 'old-hash';
    mockSpawnSync.mockReturnValueOnce({ stdout: 'new-hash\n', status: 0 } as ReturnType<typeof spawnSync>);

    updateTracker(t, 'orient', '/fake/repo');

    expect(t.graphVersionAtOrient).toBe('new-hash');
  });

  it('injectFreshness returns text unchanged after orient', () => {
    const t = freshTracker();
    t.freshnessState = 'degraded';
    updateTracker(t, 'orient', '/fake/repo');
    expect(injectFreshness('result text', t)).toBe('result text');
  });
});

// ============================================================================
// updateTracker — cognitive load accumulation
// ============================================================================

describe('updateTracker — cognitive load', () => {
  it('accumulates load by tool weight', () => {
    const t = freshTracker();
    updateTracker(t, 'search_code', '/fake/repo');         // weight 1
    updateTracker(t, 'get_subgraph', '/fake/repo');        // weight 5
    updateTracker(t, 'trace_execution_path', '/fake/repo'); // weight 8
    expect(t.cognitiveLoad).toBe(14);
  });

  it('assigns weight 1 to unknown tools', () => {
    const t = freshTracker();
    updateTracker(t, 'unknown_future_tool', '/fake/repo');
    expect(t.cognitiveLoad).toBe(1);
  });

  it('does not accumulate load for orient', () => {
    const t = freshTracker();
    updateTracker(t, 'orient', '/fake/repo');
    expect(t.cognitiveLoad).toBe(0);
  });
});

// ============================================================================
// updateTracker — state transitions (load-based)
// ============================================================================

describe('updateTracker — load-based decay', () => {
  it('transitions fresh → degraded at load >= 30', () => {
    const t = freshTracker();
    // trace_execution_path = 8, call 4 times = 32
    for (let i = 0; i < 4; i++) updateTracker(t, 'trace_execution_path', '/fake/repo');
    expect(t.freshnessState).toBe('degraded');
  });

  it('transitions directly to stale at load >= 60', () => {
    const t = freshTracker();
    // trace_execution_path = 8, call 8 times = 64
    for (let i = 0; i < 8; i++) updateTracker(t, 'trace_execution_path', '/fake/repo');
    expect(t.freshnessState).toBe('stale');
  });

  it('state never reverses: stale stays stale after orient-weight-0 tool', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('stale');
  });

  it('degraded never drops back to fresh', () => {
    const t = freshTracker();
    t.freshnessState = 'degraded';
    // Low-weight calls shouldn't reverse state
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    expect(t.freshnessState).toBe('degraded');
  });
});

// ============================================================================
// updateTracker — time-based decay
// ============================================================================

describe('updateTracker — time-based decay', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('degrades after 15 minutes', () => {
    const t = freshTracker();
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    // Trigger check with a lightweight call (won't hit load threshold alone)
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    expect(t.freshnessState).toBe('degraded');
  });

  it('goes stale after 30 minutes', () => {
    const t = freshTracker();
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    expect(t.freshnessState).toBe('stale');
  });

  it('stays fresh within 15 minutes with low load', () => {
    const t = freshTracker();
    vi.advanceTimersByTime(14 * 60 * 1000);
    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('fresh');
  });
});

// ============================================================================
// updateTracker — git hash invalidation
// ============================================================================

describe('updateTracker — git hash invalidation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('goes stale immediately when git hash changes', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = 'old-hash';
    // Advance past git check interval so the check fires
    vi.advanceTimersByTime(31_000);
    mockSpawnSync.mockReturnValueOnce({ stdout: 'new-hash\n', status: 0 } as ReturnType<typeof spawnSync>);

    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('stale');
  });

  it('stays fresh when git hash unchanged', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = 'same-hash';
    vi.advanceTimersByTime(31_000);
    mockSpawnSync.mockReturnValueOnce({ stdout: 'same-hash\n', status: 0 } as ReturnType<typeof spawnSync>);

    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('fresh');
  });

  it('skips git check within interval window', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = 'old-hash';
    // Only 5 seconds in — within 30s interval, git check skipped
    vi.advanceTimersByTime(5_000);
    mockSpawnSync.mockReturnValueOnce({ stdout: 'new-hash\n', status: 0 } as ReturnType<typeof spawnSync>);

    updateTracker(t, 'search_code', '/fake/repo');
    // Hash changed but check was skipped — not stale yet
    expect(t.freshnessState).toBe('fresh');
  });

  it('skips git comparison when either hash is empty', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = '';
    vi.advanceTimersByTime(31_000);
    mockSpawnSync.mockReturnValueOnce({ stdout: 'new-hash\n', status: 0 } as ReturnType<typeof spawnSync>);

    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('fresh');
  });
});

// ============================================================================
// updateTracker — module drift
// ============================================================================

describe('updateTracker — module drift', () => {
  it('tracks module from src/ path', () => {
    const t = freshTracker();
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/middleware.ts');
    expect(t.modulesVisited.has('auth')).toBe(true);
  });

  it('tracks distinct modules', () => {
    const t = freshTracker();
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/jwt.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/billing/stripe.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/analytics/events.ts');
    expect(t.modulesVisited.size).toBe(3);
  });

  it('degrades at > 3 distinct modules', () => {
    const t = freshTracker();
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/jwt.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/billing/stripe.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/analytics/events.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/infra/db.ts');
    expect(t.freshnessState).toBe('degraded');
  });

  it('ignores filePath without src/ prefix — no module pollution', () => {
    const t = freshTracker();
    // Absolute path with no src/ segment
    updateTracker(t, 'get_function_body', '/fake/repo', '/Users/foo/bar.ts');
    expect(t.modulesVisited.size).toBe(0);
  });

  it('deduplicates same module across calls', () => {
    const t = freshTracker();
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/jwt.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/session.ts');
    expect(t.modulesVisited.size).toBe(1);
  });

  it('does not accumulate when filePath absent', () => {
    const t = freshTracker();
    updateTracker(t, 'get_subgraph', '/fake/repo');
    expect(t.modulesVisited.size).toBe(0);
  });
});

// ============================================================================
// updateTracker — stale short-circuit (no load accumulation)
// ============================================================================

describe('updateTracker — stale short-circuit', () => {
  it('does not accumulate load when already stale', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.cognitiveLoad = 10;
    updateTracker(t, 'trace_execution_path', '/fake/repo');
    expect(t.cognitiveLoad).toBe(10); // unchanged
  });

  it('does not add modules when already stale', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/jwt.ts');
    expect(t.modulesVisited.size).toBe(0);
  });
});

// ============================================================================
// injectFreshness
// ============================================================================

describe('injectFreshness', () => {
  it('returns text unchanged when fresh', () => {
    const t = freshTracker();
    expect(injectFreshness('tool result', t)).toBe('tool result');
  });

  it('appends degraded signal — does not prepend', () => {
    const t = freshTracker();
    t.freshnessState = 'degraded';
    const out = injectFreshness('tool result', t);
    expect(out.startsWith('tool result')).toBe(true);
    expect(out).toContain('EPISTEMIC LEASE: DEGRADED');
    expect(out).toContain('orient()');
  });

  it('prepends stale block — agent sees it first', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    const out = injectFreshness('tool result', t);
    expect(out.indexOf('EPISTEMIC LEASE: STALE')).toBeLessThan(out.indexOf('tool result'));
  });

  it('stale block contains capability-invalidation language', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    const out = injectFreshness('', t);
    expect(out).toContain('Cached architectural reasoning reliability: LOW');
    expect(out).toContain('Cross-module dependency assumptions: UNRELIABLE');
    expect(out).toContain('Internal repository model: NOT AUTHORITATIVE');
  });

  it('degraded signal contains orient call-to-action', () => {
    const t = freshTracker();
    t.freshnessState = 'degraded';
    const out = injectFreshness('', t);
    expect(out).toContain('orient()');
    expect(out).toContain('DEGRADED');
  });

  it('stale block shows age in minutes', () => {
    vi.useFakeTimers();
    const t = freshTracker();
    t.freshnessState = 'stale';
    vi.advanceTimersByTime(25 * 60 * 1000);
    const out = injectFreshness('', t);
    expect(out).toContain('25min');
    vi.useRealTimers();
  });

  it('degraded signal shows module count', () => {
    const t = freshTracker();
    t.freshnessState = 'degraded';
    t.modulesVisited.add('auth');
    t.modulesVisited.add('billing');
    const out = injectFreshness('', t);
    expect(out).toContain('modules visited: 2');
  });

  it('stale block shows cognitive load score', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.cognitiveLoad = 42;
    const out = injectFreshness('', t);
    expect(out).toContain('42');
  });
});
