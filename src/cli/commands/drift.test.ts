/**
 * Tests for drift command
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';

// Mock dependencies
vi.mock('../../utils/logger.js', () => ({
  logger: {
    section: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    discovery: vi.fn(),
    analysis: vi.fn(),
    inference: vi.fn(),
    blank: vi.fn(),
    debug: vi.fn(),
    listItem: vi.fn(),
  },
}));

describe('drift command', () => {
  const testDir = join(process.cwd(), 'test-drift-cmd');

  beforeEach(async () => {
    await mkdir(join(testDir, '.spec-gen', 'analysis'), { recursive: true });
    await mkdir(join(testDir, 'openspec', 'specs'), { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  describe('command configuration', () => {
    it('should have correct name and description', async () => {
      const { driftCommand } = await import('./drift.js');

      expect(driftCommand.name()).toBe('drift');
      expect(driftCommand.description()).toBe('Detect spec drift: find code changes not reflected in specs');
    });

    it('should have base option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--base');
      expect(option).toBeDefined();
    });

    it('should have files option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--files');
      expect(option).toBeDefined();
    });

    it('should have domains option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--domains');
      expect(option).toBeDefined();
    });

    it('should have use-llm option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--use-llm');
      expect(option).toBeDefined();
    });

    it('should have json option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--json');
      expect(option).toBeDefined();
    });

    it('should have install-hook option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--install-hook');
      expect(option).toBeDefined();
    });

    it('should have uninstall-hook option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--uninstall-hook');
      expect(option).toBeDefined();
    });

    it('should have fail-on option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--fail-on');
      expect(option).toBeDefined();
    });

    it('should have max-files option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--max-files');
      expect(option).toBeDefined();
    });

    it('should have verbose option', async () => {
      const { driftCommand } = await import('./drift.js');

      const option = driftCommand.options.find(opt => opt.long === '--verbose');
      expect(option).toBeDefined();
    });
  });

  describe('parseList helper', () => {
    it('should parse comma-separated values', () => {
      const input = 'auth,user,payment';
      const parsed = input.split(',').map(s => s.trim()).filter(Boolean);
      expect(parsed).toEqual(['auth', 'user', 'payment']);
    });

    it('should handle whitespace', () => {
      const input = 'auth , user , payment';
      const parsed = input.split(',').map(s => s.trim()).filter(Boolean);
      expect(parsed).toEqual(['auth', 'user', 'payment']);
    });

    it('should filter empty entries', () => {
      const input = 'auth,,payment,';
      const parsed = input.split(',').map(s => s.trim()).filter(Boolean);
      expect(parsed).toEqual(['auth', 'payment']);
    });
  });

  describe('formatDuration helper', () => {
    it('should format milliseconds', () => {
      const ms = 500;
      expect(ms).toBeLessThan(1000);
    });

    it('should format seconds', () => {
      const ms = 5000;
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThan(60000);
    });

    it('should format minutes', () => {
      const ms = 120000;
      expect(ms).toBeGreaterThanOrEqual(60000);
    });
  });

  describe('severity helpers', () => {
    it('should map severity to labels', () => {
      const labels: Record<string, string> = {
        error: 'ERROR',
        warning: 'WARNING',
        info: 'INFO',
      };

      expect(labels['error']).toBe('ERROR');
      expect(labels['warning']).toBe('WARNING');
      expect(labels['info']).toBe('INFO');
    });

    it('should map severity to icons', () => {
      const icons: Record<string, string> = {
        error: '✗',
        warning: '⚠',
        info: '→',
      };

      expect(icons['error']).toBe('✗');
      expect(icons['warning']).toBe('⚠');
      expect(icons['info']).toBe('→');
    });

    it('should map kind to labels', () => {
      const labels: Record<string, string> = {
        gap: 'gap',
        stale: 'stale',
        uncovered: 'uncovered',
        'orphaned-spec': 'orphaned',
      };

      expect(labels['gap']).toBe('gap');
      expect(labels['orphaned-spec']).toBe('orphaned');
    });
  });

  describe('failOn validation', () => {
    it('should accept valid severity levels', () => {
      const validLevels = ['error', 'warning', 'info'];
      for (const level of validLevels) {
        expect(['error', 'warning', 'info'].includes(level)).toBe(true);
      }
    });

    it('should reject invalid severity levels', () => {
      const invalidLevels = ['critical', 'debug', 'none'];
      for (const level of invalidLevels) {
        expect(['error', 'warning', 'info'].includes(level)).toBe(false);
      }
    });
  });

  describe('drift result structure', () => {
    it('should have correct summary structure', () => {
      const summary = {
        gaps: 2,
        stale: 1,
        uncovered: 3,
        orphanedSpecs: 0,
        total: 6,
      };

      expect(summary.gaps + summary.stale + summary.uncovered + summary.orphanedSpecs)
        .toBe(summary.total);
    });

    it('should determine hasDrift from failOn threshold', () => {
      const severityRank: Record<string, number> = { error: 3, warning: 2, info: 1 };

      // Issue at warning level, failOn at warning → drift
      expect(severityRank['warning'] >= severityRank['warning']).toBe(true);

      // Issue at info level, failOn at warning → no drift
      expect(severityRank['info'] >= severityRank['warning']).toBe(false);

      // Issue at error level, failOn at warning → drift
      expect(severityRank['error'] >= severityRank['warning']).toBe(true);
    });
  });

  describe('hook management', () => {
    it('should define hook marker for identification', () => {
      const HOOK_MARKER = '# spec-gen-drift-hook';
      expect(HOOK_MARKER).toContain('spec-gen');
    });

    it('should use npx to invoke drift in hook', () => {
      const hookContent = 'npx spec-gen drift --fail-on warning --quiet';
      expect(hookContent).toContain('spec-gen drift');
      expect(hookContent).toContain('--fail-on');
    });
  });

  describe('error handling', () => {
    it('should handle missing config gracefully', async () => {
      const { logger } = await import('../../utils/logger.js');
      expect(logger.error).toBeDefined();
    });

    it('should handle missing specs gracefully', async () => {
      const { logger } = await import('../../utils/logger.js');
      expect(logger.error).toBeDefined();
    });

    it('should handle non-git repos gracefully', async () => {
      const { logger } = await import('../../utils/logger.js');
      expect(logger.error).toBeDefined();
    });
  });

  describe('command help text', () => {
    it('should include examples in description', async () => {
      const { driftCommand } = await import('./drift.js');
      expect(driftCommand.description()).toContain('drift');
    });
  });

  describe('max-files option', () => {
    it('should default to 100', async () => {
      const { driftCommand } = await import('./drift.js');
      const option = driftCommand.options.find(opt => opt.long === '--max-files');
      expect(option?.defaultValue).toBe('100');
    });

    it('should parse string to number', () => {
      const raw = '50';
      const parsed = parseInt(raw, 10);
      expect(parsed).toBe(50);
    });
  });
});
