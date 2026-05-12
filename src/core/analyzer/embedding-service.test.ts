import { describe, it, expect, vi, afterEach } from 'vitest';
import { EmbeddingService } from './embedding-service.js';
import type { OpenLoreConfig } from '../../types/index.js';

// ============================================================================
// HELPERS
// ============================================================================

function makeEmbedResponse(texts: string[], dim = 8): object {
  return {
    data: texts.map((_, i) => ({
      index: i,
      embedding: Array.from({ length: dim }, (_, j) => (i + j) * 0.1),
    })),
  };
}

function mockFetch(response: object, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    })
  );
}

// ============================================================================
// TESTS
// ============================================================================

describe('EmbeddingService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('constructor + embed', () => {
    it('returns one vector per input text', async () => {
      mockFetch(makeEmbedResponse(['hello', 'world']));

      const svc = new EmbeddingService({ baseUrl: 'http://localhost:11434/v1', model: 'test-model' });
      const result = await svc.embed(['hello', 'world']);

      expect(result).toHaveLength(2);
      expect(result[0]).toHaveLength(8);
      expect(result[1]).toHaveLength(8);
    });

    it('returns empty array for empty input', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const svc = new EmbeddingService({ baseUrl: 'http://localhost:11434/v1', model: 'test-model' });
      const result = await svc.embed([]);
      expect(result).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends Authorization header when apiKey is set', async () => {
      mockFetch(makeEmbedResponse(['text']));

      const svc = new EmbeddingService({
        baseUrl: 'http://localhost:11434/v1',
        model: 'test-model',
        apiKey: 'sk-test',
      });
      await svc.embed(['text']);

      const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const init = callArgs[1] as RequestInit;
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
    });

    it('does NOT send Authorization header when apiKey is absent', async () => {
      mockFetch(makeEmbedResponse(['text']));

      const svc = new EmbeddingService({ baseUrl: 'http://localhost:11434/v1', model: 'test-model' });
      await svc.embed(['text']);

      const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const init = callArgs[1] as RequestInit;
      expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    });

    it('batches texts according to batchSize', async () => {
      // Three texts, batchSize=2 → 2 calls
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => makeEmbedResponse(['a', 'b']),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => makeEmbedResponse(['c']),
        });
      vi.stubGlobal('fetch', fetchMock);

      const svc = new EmbeddingService({
        baseUrl: 'http://localhost:11434/v1',
        model: 'test-model',
        batchSize: 2,
      });
      const result = await svc.embed(['a', 'b', 'c']);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(3);
    });

    it('uses default batchSize of 64 when not specified', async () => {
      // Create 100 texts to test default batching
      const texts = Array.from({ length: 100 }, (_, i) => `text${i}`);
      const fetchMock = vi.fn()
        .mockResolvedValue({
          ok: true,
          json: async () => makeEmbedResponse(texts.slice(0, 64)), // First batch
        });
      vi.stubGlobal('fetch', fetchMock);

      const svc = new EmbeddingService({
        baseUrl: 'http://localhost:11434/v1',
        model: 'test-model',
        // No batchSize specified
      });
      await svc.embed(texts.slice(0, 64)); // Only first batch

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws on non-ok HTTP response', async () => {
      mockFetch({ error: 'model not found' }, 404);

      const svc = new EmbeddingService({ baseUrl: 'http://localhost:11434/v1', model: 'bad-model' });
      await expect(svc.embed(['text'])).rejects.toThrow('404');
    });

    it('throws when response has no data array', async () => {
      mockFetch({ result: [] });

      const svc = new EmbeddingService({ baseUrl: 'http://localhost:11434/v1', model: 'test-model' });
      await expect(svc.embed(['text'])).rejects.toThrow('missing "data" array');
    });

    it('sorts embeddings by index to preserve order', async () => {
      // Return data in reversed order
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: [
              { index: 1, embedding: [0.9, 0.9] },
              { index: 0, embedding: [0.1, 0.1] },
            ],
          }),
        })
      );

      const svc = new EmbeddingService({ baseUrl: 'http://localhost:11434/v1', model: 'test-model' });
      const result = await svc.embed(['first', 'second']);

      expect(result[0]).toEqual([0.1, 0.1]);
      expect(result[1]).toEqual([0.9, 0.9]);
    });

    it('strips trailing slash from baseUrl', async () => {
      mockFetch(makeEmbedResponse(['text']));

      const svc = new EmbeddingService({ baseUrl: 'http://localhost:11434/v1/', model: 'test-model' });
      await svc.embed(['text']);

      const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(url).toBe('http://localhost:11434/v1/embeddings');
    });
  });

  describe('fromEnv', () => {
    it('creates service from env vars', () => {
      vi.stubEnv('EMBED_BASE_URL', 'http://localhost:11434/v1');
      vi.stubEnv('EMBED_MODEL', 'nomic-embed-text');
      vi.stubEnv('EMBED_API_KEY', 'my-key');

      const svc = EmbeddingService.fromEnv();
      expect(svc).toBeInstanceOf(EmbeddingService);
    });

    it('throws if EMBED_BASE_URL is missing', () => {
      vi.stubEnv('EMBED_BASE_URL', '');
      vi.stubEnv('EMBED_MODEL', 'nomic-embed-text');

      expect(() => EmbeddingService.fromEnv()).toThrow('EMBED_BASE_URL');
    });

    it('throws if EMBED_MODEL is missing', () => {
      vi.stubEnv('EMBED_BASE_URL', 'http://localhost:11434/v1');
      vi.stubEnv('EMBED_MODEL', '');

      expect(() => EmbeddingService.fromEnv()).toThrow('EMBED_MODEL');
    });
  });

  describe('fromConfig', () => {
    const baseConfig: OpenLoreConfig = {
      version: '1.0.0',
      projectType: 'nodejs',
      openspecPath: './openspec',
      analysis: { maxFiles: 500, includePatterns: [], excludePatterns: [] },
      generation: { domains: 'auto' },
      createdAt: '2026-01-01T00:00:00Z',
      lastRun: null,
    };

    it('returns service when embedding config is present', () => {
      const cfg = {
        ...baseConfig,
        embedding: { baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text' },
      };
      const svc = EmbeddingService.fromConfig(cfg);
      expect(svc).toBeInstanceOf(EmbeddingService);
    });

    it('returns null when embedding config is absent', () => {
      const svc = EmbeddingService.fromConfig(baseConfig);
      expect(svc).toBeNull();
    });

    it('returns null when baseUrl is missing', () => {
      const cfg = { ...baseConfig, embedding: { baseUrl: '', model: 'nomic-embed-text' } };
      const svc = EmbeddingService.fromConfig(cfg);
      expect(svc).toBeNull();
    });

    it('returns null when model is missing', () => {
      const cfg = { ...baseConfig, embedding: { baseUrl: 'http://localhost:11434/v1', model: '' } };
      const svc = EmbeddingService.fromConfig(cfg);
      expect(svc).toBeNull();
    });
  });
});
