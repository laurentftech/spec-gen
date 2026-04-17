/**
 * Tests for decision verifier — LLM call + JSON parsing robustness
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyDecisions } from './verifier.js';
import type { PendingDecision } from '../../types/index.js';
import type { LLMService } from '../services/llm-service.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), section: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn() },
}));

// ============================================================================
// HELPERS
// ============================================================================

function makeLLM(response: string): LLMService {
  return {
    complete: vi.fn().mockResolvedValue({ content: response, model: 'test-model' }),
    completeJSON: vi.fn(),
    saveLogs: vi.fn().mockResolvedValue(undefined),
  } as unknown as LLMService;
}

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'aaaa0001',
    status: 'consolidated',
    title: 'Use Redis for caching',
    rationale: 'Reduces DB load',
    consequences: 'Needs cache invalidation',
    proposedRequirement: 'The system SHALL use Redis',
    affectedDomains: ['cache'],
    affectedFiles: ['src/cache.ts'],
    sessionId: 'sess001',
    recordedAt: '2026-01-01T00:00:00.000Z',
    confidence: 'medium',
    syncedToSpecs: [],
    ...overrides,
  };
}

const VALID_RESPONSE = JSON.stringify({
  verified: [{ id: 'aaaa0001', evidenceFile: 'src/cache.ts', confidence: 'high' }],
  phantom: [],
  missing: [],
});

// ============================================================================
// Empty / no-op cases
// ============================================================================

describe('verifyDecisions — empty', () => {
  it('returns empty result when decisions array is empty', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const result = await verifyDecisions([], 'some diff', llm);
    expect(result.verified).toHaveLength(0);
    expect(result.phantom).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Happy path
// ============================================================================

describe('verifyDecisions — happy path', () => {
  it('marks decisions as verified when LLM confirms', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const d = makeDecision();
    const result = await verifyDecisions([d], 'diff content', llm);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0].status).toBe('verified');
    expect(result.verified[0].confidence).toBe('high');
    expect(result.verified[0].evidenceFile).toBe('src/cache.ts');
  });

  it('marks decisions as phantom when LLM says phantom', async () => {
    const response = JSON.stringify({ verified: [], phantom: [{ id: 'aaaa0001' }], missing: [] });
    const llm = makeLLM(response);
    const d = makeDecision();
    const result = await verifyDecisions([d], 'diff', llm);
    expect(result.phantom).toHaveLength(1);
    expect(result.phantom[0].status).toBe('phantom');
    expect(result.phantom[0].confidence).toBe('low');
  });

  it('surfaces missing changes from LLM', async () => {
    const response = JSON.stringify({
      verified: [],
      phantom: [],
      missing: [{ file: 'src/auth.ts', description: 'Added JWT middleware without a decision' }],
    });
    const llm = makeLLM(response);
    const d = makeDecision();
    const result = await verifyDecisions([d], 'diff', llm);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].file).toBe('src/auth.ts');
  });

  it('silently drops verified entries with unknown IDs', async () => {
    const response = JSON.stringify({
      verified: [{ id: 'unknownid', evidenceFile: 'x.ts', confidence: 'high' }],
      phantom: [],
      missing: [],
    });
    const llm = makeLLM(response);
    const d = makeDecision({ id: 'aaaa0001' });
    const result = await verifyDecisions([d], 'diff', llm);
    expect(result.verified).toHaveLength(0);
  });
});

// ============================================================================
// JSON parsing robustness (H1)
// ============================================================================

describe('verifyDecisions — JSON parsing robustness', () => {
  it('parses plain JSON object', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const result = await verifyDecisions([makeDecision()], 'diff', llm);
    expect(result.verified).toHaveLength(1);
  });

  it('parses JSON wrapped in ```json ... ``` fences', async () => {
    const fenced = '```json\n' + VALID_RESPONSE + '\n```';
    const llm = makeLLM(fenced);
    const result = await verifyDecisions([makeDecision()], 'diff', llm);
    expect(result.verified).toHaveLength(1);
  });

  it('parses JSON wrapped in plain ``` fences', async () => {
    const fenced = '```\n' + VALID_RESPONSE + '\n```';
    const llm = makeLLM(fenced);
    const result = await verifyDecisions([makeDecision()], 'diff', llm);
    expect(result.verified).toHaveLength(1);
  });

  it('returns empty verified/phantom/missing on completely malformed response', async () => {
    const llm = makeLLM('I cannot determine this.');
    const result = await verifyDecisions([makeDecision()], 'diff', llm);
    expect(result.verified).toHaveLength(0);
    expect(result.phantom).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
  });

  it('returns empty result on invalid JSON inside fences', async () => {
    const llm = makeLLM('```json\nnot json\n```');
    const result = await verifyDecisions([makeDecision()], 'diff', llm);
    expect(result.verified).toHaveLength(0);
  });
});

// ============================================================================
// Diff truncation warning (M3)
// ============================================================================

describe('verifyDecisions — diff truncation warning', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does not warn when diff is within limit', async () => {
    const { logger } = await import('./verifier.js').then(() => import('../../utils/logger.js'));
    const llm = makeLLM(VALID_RESPONSE);
    await verifyDecisions([makeDecision()], 'short diff', llm);
    expect(vi.mocked(logger.warning)).not.toHaveBeenCalled();
  });

  it('warns when diff exceeds 20 000 chars', async () => {
    const { logger } = await import('../../utils/logger.js');
    const llm = makeLLM(VALID_RESPONSE);
    const longDiff = 'x'.repeat(20_001);
    await verifyDecisions([makeDecision()], longDiff, llm);
    expect(vi.mocked(logger.warning)).toHaveBeenCalledWith(
      expect.stringContaining('truncated'),
    );
  });
});
