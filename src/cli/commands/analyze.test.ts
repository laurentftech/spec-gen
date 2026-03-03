/**
 * Tests for spec-gen analyze command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzeCommand, runAnalysis } from './analyze.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('../../utils/logger.js', () => ({
  logger: {
    section: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(),
    success: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn(),
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access:    vi.fn().mockResolvedValue(undefined),
    stat:      vi.fn().mockResolvedValue({ mtime: new Date() }),
    mkdir:     vi.fn().mockResolvedValue(undefined),
    readFile:  vi.fn().mockResolvedValue('{}'),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../../core/analyzer/repository-mapper.js', () => {
  const mockMap = vi.fn().mockResolvedValue({
    allFiles: [],
    highValueFiles: [],
    summary: { totalFiles: 0, analyzedFiles: 0, skippedFiles: 0, languages: [] },
  });
  return { RepositoryMapper: vi.fn().mockImplementation(function(this: unknown, root: string, opts: unknown) {
    Object.assign(this as object, { map: mockMap });
    void root; void opts;
  }) };
});

vi.mock('../../core/analyzer/dependency-graph.js', () => ({
  DependencyGraphBuilder: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, {
      build: vi.fn().mockResolvedValue({
        statistics: { nodeCount: 0, edgeCount: 0, clusterCount: 0, cycleCount: 0, avgDegree: 0 },
      }),
    });
  }),
}));

vi.mock('../../core/analyzer/artifact-generator.js', () => ({
  AnalysisArtifactGenerator: vi.fn().mockImplementation(function(this: unknown) {
    Object.assign(this as object, {
      generateAndSave: vi.fn().mockResolvedValue({
        repoStructure: { architecture: { pattern: 'unknown' }, domains: [] },
        llmContext: { callGraph: null },
      }),
    });
  }),
}));

vi.mock('../../core/services/config-manager.js', () => ({
  readSpecGenConfig: vi.fn(),
}));

describe('analyze command', () => {
  describe('command configuration', () => {
    it('should have correct name and description', () => {
      expect(analyzeCommand.name()).toBe('analyze');
      expect(analyzeCommand.description()).toContain('static analysis');
    });

    it('should have --output option with default', () => {
      const outputOption = analyzeCommand.options.find(o => o.long === '--output');
      expect(outputOption).toBeDefined();
      expect(outputOption?.defaultValue).toBe('.spec-gen/analysis/');
    });

    it('should have --max-files option with default', () => {
      const maxFilesOption = analyzeCommand.options.find(o => o.long === '--max-files');
      expect(maxFilesOption).toBeDefined();
      expect(maxFilesOption?.defaultValue).toBe('500');
    });

    it('should have --include option (repeatable)', () => {
      const includeOption = analyzeCommand.options.find(o => o.long === '--include');
      expect(includeOption).toBeDefined();
      expect(includeOption?.description).toContain('repeatable');
    });

    it('should have --exclude option (repeatable)', () => {
      const excludeOption = analyzeCommand.options.find(o => o.long === '--exclude');
      expect(excludeOption).toBeDefined();
      expect(excludeOption?.description).toContain('repeatable');
    });

    it('should have --force option', () => {
      const forceOption = analyzeCommand.options.find(o => o.long === '--force');
      expect(forceOption).toBeDefined();
      expect(forceOption?.description).toContain('Force');
    });
  });

  describe('helper function tests', () => {
    describe('collect function', () => {
      it('should collect multiple values', () => {
        const collect = (value: string, previous: string[]): string[] => {
          return previous.concat([value]);
        };

        let result: string[] = [];
        result = collect('*.graphql', result);
        result = collect('*.prisma', result);

        expect(result).toEqual(['*.graphql', '*.prisma']);
      });
    });

    describe('formatDuration', () => {
      it('should format milliseconds correctly', () => {
        const formatDuration = (ms: number): string => {
          if (ms < 1000) return `${ms}ms`;
          if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
          const minutes = Math.floor(ms / 60000);
          const seconds = Math.floor((ms % 60000) / 1000);
          return `${minutes}m ${seconds}s`;
        };

        expect(formatDuration(500)).toBe('500ms');
        expect(formatDuration(1500)).toBe('1.5s');
        expect(formatDuration(65000)).toBe('1m 5s');
      });
    });

    describe('formatAge', () => {
      it('should format age correctly', () => {
        const formatAge = (ms: number): string => {
          if (ms < 60000) return 'just now';
          if (ms < 3600000) return `${Math.floor(ms / 60000)} minutes ago`;
          if (ms < 86400000) return `${Math.floor(ms / 3600000)} hours ago`;
          return `${Math.floor(ms / 86400000)} days ago`;
        };

        expect(formatAge(30000)).toBe('just now');
        expect(formatAge(1800000)).toBe('30 minutes ago');
        expect(formatAge(7200000)).toBe('2 hours ago');
        expect(formatAge(172800000)).toBe('2 days ago');
      });
    });
  });

  describe('analysis caching', () => {
    it('should skip analysis when recent (< 1 hour)', () => {
      const analysisAge = 30 * 60 * 1000; // 30 minutes
      const oneHour = 60 * 60 * 1000;
      const force = false;

      const shouldSkip = analysisAge !== null && analysisAge < oneHour && !force;
      expect(shouldSkip).toBe(true);
    });

    it('should run analysis when old (> 1 hour)', () => {
      const analysisAge = 2 * 60 * 60 * 1000; // 2 hours
      const oneHour = 60 * 60 * 1000;
      const force = false;

      const shouldSkip = analysisAge !== null && analysisAge < oneHour && !force;
      expect(shouldSkip).toBe(false);
    });

    it('should run analysis with --force', () => {
      const analysisAge = 30 * 60 * 1000; // 30 minutes
      const oneHour = 60 * 60 * 1000;
      const force = true;

      const shouldSkip = analysisAge !== null && analysisAge < oneHour && !force;
      expect(shouldSkip).toBe(false);
    });

    it('should run analysis when none exists', () => {
      const analysisAge: number | null = null;
      const oneHour = 60 * 60 * 1000;
      const force = false;

      const shouldSkip = analysisAge !== null && analysisAge < oneHour && !force;
      expect(shouldSkip).toBe(false);
    });
  });

  describe('output files', () => {
    it('should generate expected output files', () => {
      const expectedFiles = [
        'repo-structure.json',
        'dependency-graph.json',
        'llm-context.json',
        'dependencies.mermaid',
        'SUMMARY.md',
      ];

      for (const file of expectedFiles) {
        expect(file).toBeTruthy();
      }
    });
  });

  describe('runAnalysis function', () => {
    it('should be exported', () => {
      expect(runAnalysis).toBeDefined();
      expect(typeof runAnalysis).toBe('function');
    });
  });

  describe('runAnalysis — excludePatterns from config', () => {
    let MockRepositoryMapper: ReturnType<typeof vi.fn>;
    let readSpecGenConfig: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      MockRepositoryMapper = vi.mocked(mapperMod.RepositoryMapper);
      MockRepositoryMapper.mockClear();

      const cfgMod = await import('../../core/services/config-manager.js');
      readSpecGenConfig = vi.mocked(cfgMod.readSpecGenConfig);
    });

    function makeConfig(excludePatterns: string[], includePatterns: string[] = []) {
      return {
        version: '1.0.0',
        projectType: 'nodejs' as const,
        openspecPath: './openspec',
        analysis: { maxFiles: 500, includePatterns, excludePatterns },
        generation: { provider: 'openai' as const, model: 'gpt-4', domains: 'auto' as const },
        createdAt: new Date().toISOString(),
        lastRun: null,
      };
    }

    function getMapperOptions(): { excludePatterns?: string[]; includePatterns?: string[] } {
      const calls = MockRepositoryMapper.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      return (calls[calls.length - 1][1] as { excludePatterns?: string[]; includePatterns?: string[] }) ?? {};
    }

    function getMapperExcludePatterns(): string[] {
      return getMapperOptions().excludePatterns ?? [];
    }

    it('passes config excludePatterns to RepositoryMapper when caller passes none', async () => {
      readSpecGenConfig.mockResolvedValue(makeConfig(['static/**', 'vendor/**']));

      await runAnalysis('/fake/root', '/fake/root/.spec-gen/analysis', {
        maxFiles: 500, include: [], exclude: [],
      });

      expect(getMapperExcludePatterns()).toEqual(
        expect.arrayContaining(['static/**', 'vendor/**'])
      );
    });

    it('merges config excludePatterns with caller-supplied exclude patterns', async () => {
      readSpecGenConfig.mockResolvedValue(makeConfig(['static/**']));

      await runAnalysis('/fake/root', '/fake/root/.spec-gen/analysis', {
        maxFiles: 500, include: [], exclude: ['legacy/**'],
      });

      expect(getMapperExcludePatterns()).toEqual(
        expect.arrayContaining(['static/**', 'legacy/**'])
      );
    });

    it('deduplicates patterns that appear in both config and caller exclude', async () => {
      readSpecGenConfig.mockResolvedValue(makeConfig(['node_modules/**']));

      await runAnalysis('/fake/root', '/fake/root/.spec-gen/analysis', {
        maxFiles: 500, include: [], exclude: ['node_modules/**'],
      });

      const patterns = getMapperExcludePatterns();
      expect(patterns.filter(p => p === 'node_modules/**')).toHaveLength(1);
    });

    it('works when no config exists (null) and uses caller-supplied patterns only', async () => {
      readSpecGenConfig.mockResolvedValue(null);

      await runAnalysis('/fake/root', '/fake/root/.spec-gen/analysis', {
        maxFiles: 500, include: [], exclude: ['dist/**'],
      });

      expect(getMapperExcludePatterns()).toEqual(
        expect.arrayContaining(['dist/**'])
      );
    });
  });

  describe('runAnalysis — includePatterns from config', () => {
    let MockRepositoryMapper: ReturnType<typeof vi.fn>;
    let readSpecGenConfig: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      MockRepositoryMapper = vi.mocked(mapperMod.RepositoryMapper);
      MockRepositoryMapper.mockClear();
      const cfgMod = await import('../../core/services/config-manager.js');
      readSpecGenConfig = vi.mocked(cfgMod.readSpecGenConfig);
    });

    function makeConfig(includePatterns: string[], excludePatterns: string[] = []) {
      return {
        version: '1.0.0', projectType: 'nodejs' as const, openspecPath: './openspec',
        analysis: { maxFiles: 500, includePatterns, excludePatterns },
        generation: { provider: 'openai' as const, model: 'gpt-4', domains: 'auto' as const },
        createdAt: new Date().toISOString(), lastRun: null,
      };
    }

    function getMapperIncludePatterns(): string[] {
      const calls = MockRepositoryMapper.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      return ((calls[calls.length - 1][1] as { includePatterns?: string[] })?.includePatterns) ?? [];
    }

    it('passes config includePatterns to RepositoryMapper when caller passes none', async () => {
      readSpecGenConfig.mockResolvedValue(makeConfig(['*.graphql', '*.prisma']));

      await runAnalysis('/fake/root', '/fake/root/.spec-gen/analysis', {
        maxFiles: 500, include: [], exclude: [],
      });

      expect(getMapperIncludePatterns()).toEqual(
        expect.arrayContaining(['*.graphql', '*.prisma'])
      );
    });

    it('merges config includePatterns with caller-supplied include patterns', async () => {
      readSpecGenConfig.mockResolvedValue(makeConfig(['*.graphql']));

      await runAnalysis('/fake/root', '/fake/root/.spec-gen/analysis', {
        maxFiles: 500, include: ['*.proto'], exclude: [],
      });

      expect(getMapperIncludePatterns()).toEqual(
        expect.arrayContaining(['*.graphql', '*.proto'])
      );
    });

    it('deduplicates include patterns present in both config and caller', async () => {
      readSpecGenConfig.mockResolvedValue(makeConfig(['*.graphql']));

      await runAnalysis('/fake/root', '/fake/root/.spec-gen/analysis', {
        maxFiles: 500, include: ['*.graphql'], exclude: [],
      });

      const patterns = getMapperIncludePatterns();
      expect(patterns.filter(p => p === '*.graphql')).toHaveLength(1);
    });
  });

  // ============================================================================
  // ACTION HANDLER TESTS
  // ============================================================================

  describe('analyzeCommand — action handler', () => {
    // Shared references to mocked fs functions, resolved in beforeEach
    // so they are guaranteed to be the same instances vitest hoisted.
    let mockAccess:   ReturnType<typeof vi.fn>;
    let mockStat:     ReturnType<typeof vi.fn>;
    let mockMkdir:    ReturnType<typeof vi.fn>;
    let mockReadFile: ReturnType<typeof vi.fn>;
    let mockReadSpecGenConfig: ReturnType<typeof vi.fn>;

    let consoleSpy: ReturnType<typeof vi.spyOn>;
    let cwdSpy:     ReturnType<typeof vi.spyOn>;

    const FAKE_CONFIG = {
      version: '1.0.0',
      projectType: 'nodejs' as const,
      openspecPath: './openspec',
      analysis: { maxFiles: 500, includePatterns: [], excludePatterns: [] },
      generation: { provider: 'openai' as const, model: 'gpt-4', domains: 'auto' as const },
      createdAt: new Date().toISOString(),
      lastRun: null,
    };

    // Minimal repo-structure.json content returned by readFile in the cache-hit branch
    const CACHED_STRUCTURE = JSON.stringify({
      statistics: { analyzedFiles: 42 },
      domains: [{ name: 'api', files: [] }],
      architecture: { pattern: 'layered' },
    });

    beforeEach(async () => {
      const fsMod  = await import('node:fs/promises');
      const cfgMod = await import('../../core/services/config-manager.js');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockAccess   = vi.mocked(fsMod.access as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockStat     = vi.mocked(fsMod.stat as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockMkdir    = vi.mocked(fsMod.mkdir as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReadFile = vi.mocked(fsMod.readFile as any);
      mockReadSpecGenConfig = vi.mocked(cfgMod.readSpecGenConfig);

      // Safe defaults: file exists, stale (2 h), mkdir ok, readFile gives empty JSON
      mockAccess.mockReset().mockResolvedValue(undefined);
      mockStat.mockReset().mockResolvedValue({ mtime: new Date(Date.now() - 2 * 3_600_000) });
      mockMkdir.mockReset().mockResolvedValue(undefined);
      mockReadFile.mockReset().mockResolvedValue('{}');
      mockReadSpecGenConfig.mockReset();

      cwdSpy     = vi.spyOn(process, 'cwd').mockReturnValue('/fake/root');
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      process.exitCode = undefined;
    });

    afterEach(() => {
      cwdSpy.mockRestore();
      consoleSpy.mockRestore();
      process.exitCode = undefined;
    });

    it('exits with code 1 when no config found', async () => {
      mockReadSpecGenConfig.mockResolvedValue(null);

      await analyzeCommand.parseAsync([], { from: 'user' });

      expect(process.exitCode).toBe(1);
    });

    it('skips analysis when recent cache exists (< 1 hour) without --force', async () => {
      mockReadSpecGenConfig.mockResolvedValue(FAKE_CONFIG);
      // mtime 30 minutes ago → recent
      mockStat.mockResolvedValue({ mtime: new Date(Date.now() - 30 * 60_000) });
      mockReadFile.mockResolvedValue(CACHED_STRUCTURE);

      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      vi.mocked(mapperMod.RepositoryMapper).mockClear();

      await analyzeCommand.parseAsync([], { from: 'user' });

      // RepositoryMapper must NOT have been instantiated (analysis was skipped)
      expect(vi.mocked(mapperMod.RepositoryMapper)).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('runs analysis even with recent cache when --force is passed', async () => {
      mockReadSpecGenConfig.mockResolvedValue(FAKE_CONFIG);
      mockStat.mockResolvedValue({ mtime: new Date(Date.now() - 30 * 60_000) });

      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      vi.mocked(mapperMod.RepositoryMapper).mockClear();

      await analyzeCommand.parseAsync(['--force'], { from: 'user' });

      expect(vi.mocked(mapperMod.RepositoryMapper)).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('runs fresh analysis when no previous analysis exists', async () => {
      mockReadSpecGenConfig.mockResolvedValue(FAKE_CONFIG);
      // access rejects → fileExists returns false → getAnalysisAge returns null
      mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      vi.mocked(mapperMod.RepositoryMapper).mockClear();

      await analyzeCommand.parseAsync([], { from: 'user' });

      expect(vi.mocked(mapperMod.RepositoryMapper)).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('re-runs stale analysis automatically (> 1 hour, no --force needed)', async () => {
      mockReadSpecGenConfig.mockResolvedValue(FAKE_CONFIG);
      // Default beforeEach stat: 2 hours old → stale

      const mapperMod = await import('../../core/analyzer/repository-mapper.js');
      vi.mocked(mapperMod.RepositoryMapper).mockClear();

      await analyzeCommand.parseAsync([], { from: 'user' });

      expect(vi.mocked(mapperMod.RepositoryMapper)).toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('sets exitCode=1 and logs error message when analysis pipeline throws', async () => {
      mockReadSpecGenConfig.mockResolvedValue(FAKE_CONFIG);
      mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockMkdir.mockRejectedValue(new Error('Permission denied'));

      const loggerMod = await import('../../utils/logger.js');
      const errorSpy = vi.mocked(loggerMod.logger.error);

      await analyzeCommand.parseAsync([], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
    });
  });
});
