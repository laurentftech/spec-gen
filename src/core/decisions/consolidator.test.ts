/**
 * Tests for decision consolidator — LLM call + JSON parsing robustness
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { consolidateDrafts } from './consolidator.js';
import type { DecisionStore, PendingDecision } from '../../types/index.js';
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

function makeStore(drafts: Partial<PendingDecision>[] = []): DecisionStore {
  return {
    version: '1',
    sessionId: 'sess001aabbcc',
    updatedAt: '2026-01-01T00:00:00.000Z',
    decisions: drafts.map((d, i) => ({
      id: `draft${String(i).padStart(4, '0')}`,
      status: 'draft' as const,
      title: `Decision ${i}`,
      rationale: 'Some rationale',
      consequences: 'Some consequences',
      proposedRequirement: null,
      affectedDomains: ['api'],
      affectedFiles: [],
      sessionId: 'sess001aabbcc',
      recordedAt: '2026-01-01T00:00:00.000Z',
      confidence: 'medium' as const,
      syncedToSpecs: [],
      ...d,
    })),
  };
}

const VALID_RESPONSE = JSON.stringify([
  {
    title: 'Use Redis for caching',
    rationale: 'Reduces DB load',
    consequences: 'Needs cache invalidation strategy',
    affectedDomains: ['cache'],
    affectedFiles: ['src/cache.ts'],
    proposedRequirement: 'The system SHALL use Redis for session caching',
    supersededIds: ['draft0000'],
  },
]);

// ============================================================================
// Empty / no-op cases
// ============================================================================

describe('consolidateDrafts — empty store', () => {
  it('returns empty result when store has no drafts', async () => {
    const llm = makeLLM('[]');
    const store = makeStore([]);
    const result = await consolidateDrafts(store, llm);
    expect(result.decisions).toHaveLength(0);
    expect(result.supersededIds).toHaveLength(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('skips non-draft decisions', async () => {
    const llm = makeLLM('[]');
    const store = makeStore([{ status: 'approved' }, { status: 'synced' }]);
    const result = await consolidateDrafts(store, llm);
    expect(result.decisions).toHaveLength(0);
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Happy path
// ============================================================================

describe('consolidateDrafts — happy path', () => {
  it('returns consolidated decisions from LLM response', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const store = makeStore([{ title: 'Draft decision' }]);
    const { decisions } = await consolidateDrafts(store, llm);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].title).toBe('Use Redis for caching');
    expect(decisions[0].status).toBe('consolidated');
    expect(decisions[0].affectedDomains).toEqual(['cache']);
  });

  it('extracts supersededIds from LLM response', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const store = makeStore([{ title: 'Draft' }]);
    const { supersededIds } = await consolidateDrafts(store, llm);
    expect(supersededIds).toEqual(['draft0000']);
  });

  it('assigns a deterministic id from sessionId + domain + title', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const store = makeStore([{ title: 'Draft' }]);
    const { decisions } = await consolidateDrafts(store, llm);
    expect(decisions[0].id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('sets consolidatedAt timestamp', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const store = makeStore([{ title: 'Draft' }]);
    const { decisions } = await consolidateDrafts(store, llm);
    expect(decisions[0].consolidatedAt).toBeDefined();
  });
});

// ============================================================================
// JSON parsing robustness (H1)
// ============================================================================

describe('consolidateDrafts — JSON parsing robustness', () => {
  it('parses plain JSON array', async () => {
    const llm = makeLLM(VALID_RESPONSE);
    const store = makeStore([{}]);
    const { decisions } = await consolidateDrafts(store, llm);
    expect(decisions).toHaveLength(1);
  });

  it('parses JSON wrapped in ```json ... ``` fences', async () => {
    const fenced = '```json\n' + VALID_RESPONSE + '\n```';
    const llm = makeLLM(fenced);
    const store = makeStore([{}]);
    const { decisions } = await consolidateDrafts(store, llm);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].title).toBe('Use Redis for caching');
  });

  it('parses JSON wrapped in plain ``` fences', async () => {
    const fenced = '```\n' + VALID_RESPONSE + '\n```';
    const llm = makeLLM(fenced);
    const store = makeStore([{}]);
    const { decisions } = await consolidateDrafts(store, llm);
    expect(decisions).toHaveLength(1);
  });

  it('returns empty decisions on completely malformed response', async () => {
    const llm = makeLLM('Sorry, I cannot help with that.');
    const store = makeStore([{}]);
    const { decisions } = await consolidateDrafts(store, llm);
    expect(decisions).toHaveLength(0);
  });

  it('returns empty decisions on empty JSON array response', async () => {
    const llm = makeLLM('[]');
    const store = makeStore([{}]);
    const { decisions } = await consolidateDrafts(store, llm);
    expect(decisions).toHaveLength(0);
  });

  it('returns empty decisions on invalid JSON inside fences', async () => {
    const llm = makeLLM('```json\nnot valid json\n```');
    const store = makeStore([{}]);
    const { decisions } = await consolidateDrafts(store, llm);
    expect(decisions).toHaveLength(0);
  });
});

// ============================================================================
// Mitigation: warn when LLM returns fewer decisions than drafts
// ============================================================================

describe('consolidateDrafts — consolidation warning', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does not warn when consolidation is non-empty', async () => {
    const { logger } = await import('../../utils/logger.js');
    const llm = makeLLM(VALID_RESPONSE);
    const store = makeStore([{}]);
    await consolidateDrafts(store, llm);
    expect(vi.mocked(logger.warning)).not.toHaveBeenCalled();
  });

  it('warns when LLM returns empty array for non-empty drafts', async () => {
    const { logger } = await import('../../utils/logger.js');
    const llm = makeLLM('[]');
    const store = makeStore([{ title: 'Draft A' }, { title: 'Draft B' }]);
    await consolidateDrafts(store, llm);
    expect(vi.mocked(logger.warning)).toHaveBeenCalledWith(
      expect.stringContaining('consolidation returned 0 decisions from 2 drafts'),
    );
  });

  it('warns when LLM returns malformed JSON for non-empty drafts', async () => {
    const { logger } = await import('../../utils/logger.js');
    const llm = makeLLM('not json at all');
    const store = makeStore([{ title: 'Draft' }]);
    await consolidateDrafts(store, llm);
    expect(vi.mocked(logger.warning)).toHaveBeenCalled();
  });
});
