/**
 * Tests for config-manager service
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getDefaultConfig,
  readOpenLoreConfig,
  writeOpenLoreConfig,
  openloreConfigExists,
  readOpenSpecConfig,
  writeOpenSpecConfig,
  openspecDirExists,
  openspecConfigExists,
  createOpenSpecStructure,
  mergeOpenSpecConfig,
} from './config-manager.js';

describe('config-manager', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `openlore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('getDefaultConfig', () => {
    it('should return config with correct defaults', () => {
      const config = getDefaultConfig('nodejs', './openspec');

      expect(config.version).toBe('1.0.0');
      expect(config.projectType).toBe('nodejs');
      expect(config.openspecPath).toBe('./openspec');
      expect(config.analysis.maxFiles).toBe(100_000);
      expect(config.analysis.includePatterns).toEqual([]);
      expect(config.analysis.excludePatterns).toEqual([]);
      expect(config.generation.model).toBe('claude-sonnet-4-20250514');
      expect(config.generation.domains).toBe('auto');
      expect(config.createdAt).toBeDefined();
      expect(config.lastRun).toBe(null);
    });

    it('should use provided project type', () => {
      const config = getDefaultConfig('python', './specs');

      expect(config.projectType).toBe('python');
      expect(config.openspecPath).toBe('./specs');
    });
  });

  describe('openloreConfigExists', () => {
    it('should return false when config does not exist', async () => {
      const result = await openloreConfigExists(testDir);
      expect(result).toBe(false);
    });

    it('should return true when config exists', async () => {
      await mkdir(join(testDir, '.openlore'), { recursive: true });
      await writeFile(join(testDir, '.openlore', 'config.json'), '{}');

      const result = await openloreConfigExists(testDir);
      expect(result).toBe(true);
    });
  });

  describe('writeOpenLoreConfig and readOpenLoreConfig', () => {
    it('should write and read config correctly', async () => {
      const config = getDefaultConfig('rust', './docs/specs');

      await writeOpenLoreConfig(testDir, config);
      const readConfig = await readOpenLoreConfig(testDir);

      expect(readConfig).toEqual(config);
    });

    it('should create .openlore directory if it does not exist', async () => {
      const config = getDefaultConfig('go', './openspec');

      await writeOpenLoreConfig(testDir, config);

      const content = await readFile(join(testDir, '.openlore', 'config.json'), 'utf-8');
      expect(JSON.parse(content)).toEqual(config);
    });

    it('should return null when config does not exist', async () => {
      const result = await readOpenLoreConfig(testDir);
      expect(result).toBe(null);
    });
  });

  describe('openspecDirExists', () => {
    it('should return false when directory does not exist', async () => {
      const result = await openspecDirExists(join(testDir, 'openspec'));
      expect(result).toBe(false);
    });

    it('should return true when directory exists', async () => {
      await mkdir(join(testDir, 'openspec'));

      const result = await openspecDirExists(join(testDir, 'openspec'));
      expect(result).toBe(true);
    });
  });

  describe('openspecConfigExists', () => {
    it('should return false when config.yaml does not exist', async () => {
      await mkdir(join(testDir, 'openspec'));

      const result = await openspecConfigExists(join(testDir, 'openspec'));
      expect(result).toBe(false);
    });

    it('should return true when config.yaml exists', async () => {
      await mkdir(join(testDir, 'openspec'));
      await writeFile(join(testDir, 'openspec', 'config.yaml'), 'schema: spec-driven');

      const result = await openspecConfigExists(join(testDir, 'openspec'));
      expect(result).toBe(true);
    });
  });

  describe('writeOpenSpecConfig and readOpenSpecConfig', () => {
    it('should write and read YAML config correctly', async () => {
      const config = {
        schema: 'spec-driven',
        context: 'Test project context',
      };

      const openspecPath = join(testDir, 'openspec');
      await writeOpenSpecConfig(openspecPath, config);
      const readConfig = await readOpenSpecConfig(openspecPath);

      expect(readConfig).toEqual(config);
    });

    it('should return null when config does not exist', async () => {
      const result = await readOpenSpecConfig(join(testDir, 'openspec'));
      expect(result).toBe(null);
    });
  });

  describe('createOpenSpecStructure', () => {
    it('should create openspec directory and specs subdirectory', async () => {
      const openspecPath = join(testDir, 'openspec');

      await createOpenSpecStructure(openspecPath);

      expect(await openspecDirExists(openspecPath)).toBe(true);
      expect(await openspecDirExists(join(openspecPath, 'specs'))).toBe(true);
    });
  });

  describe('mergeOpenSpecConfig', () => {
    it('should create new config when existing is null', () => {
      const openloreMeta = {
        generatedAt: '2025-01-30T12:00:00Z',
        domains: ['auth', 'api'],
        confidence: 0.85,
      };

      const result = mergeOpenSpecConfig(null, openloreMeta);

      expect(result.schema).toBe('spec-driven');
      expect(result.context).toBe('');
      expect(result['openlore']).toEqual(openloreMeta);
    });

    it('should preserve existing config and merge openlore metadata', () => {
      const existing = {
        schema: 'custom-schema',
        context: 'Existing context',
        customField: 'value',
      };
      const openloreMeta = {
        generatedAt: '2025-01-30T12:00:00Z',
        domains: ['auth'],
      };

      const result = mergeOpenSpecConfig(existing, openloreMeta);

      expect(result.schema).toBe('custom-schema');
      expect(result.context).toBe('Existing context');
      expect(result.customField).toBe('value');
      expect(result['openlore']).toEqual(openloreMeta);
    });

    it('should merge openlore metadata with existing openlore data', () => {
      const existing = {
        schema: 'spec-driven',
        'openlore': {
          generatedAt: '2025-01-29T12:00:00Z',
          sourceProject: 'Original',
        },
      };
      const openloreMeta = {
        generatedAt: '2025-01-30T12:00:00Z',
        domains: ['api'],
      };

      const result = mergeOpenSpecConfig(existing, openloreMeta);

      expect(result['openlore']?.generatedAt).toBe('2025-01-30T12:00:00Z');
      expect(result['openlore']?.sourceProject).toBe('Original');
      expect(result['openlore']?.domains).toEqual(['api']);
    });
  });

  describe('readOpenLoreConfig — malformed JSON', () => {
    it('returns null when config.json contains invalid JSON', async () => {
      const configDir = join(testDir, '.openlore');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), '{ invalid json !!!', 'utf-8');

      const result = await readOpenLoreConfig(testDir);
      expect(result).toBeNull();
    });
  });

  describe('readOpenSpecConfig — malformed YAML', () => {
    it('returns null when config.yaml contains invalid YAML', async () => {
      const openspecDir = join(testDir, 'openspec');
      await mkdir(openspecDir, { recursive: true });
      // This string is syntactically invalid YAML (tabs where spaces expected, etc.)
      await writeFile(join(openspecDir, 'config.yaml'), 'key: [unclosed bracket', 'utf-8');

      const result = await readOpenSpecConfig(openspecDir);
      // Invalid YAML should return null (caught internally)
      expect(result).toBeNull();
    });
  });
});
