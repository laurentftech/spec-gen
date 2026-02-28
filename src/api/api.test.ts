/**
 * Tests for the spec-gen programmatic API
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { specGenInit } from './init.js';
import { specGenAnalyze } from './analyze.js';
import { specGenDrift } from './drift.js';
import type { ProgressEvent } from './types.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

let testDir: string;

async function createTestProject(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });

  // Create package.json (project manifest)
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'test-project',
    version: '1.0.0',
    type: 'module',
  }, null, 2));

  // Create a source file
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'index.ts'), `
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export function add(a: number, b: number): number {
  return a + b;
}
`);

  await writeFile(join(dir, 'src', 'utils.ts'), `
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
`);

  // Create .gitignore
  await writeFile(join(dir, '.gitignore'), 'node_modules/\ndist/\n');
}

// ============================================================================
// TESTS: specGenInit
// ============================================================================

describe('specGenInit', () => {
  beforeEach(async () => {
    testDir = join(tmpdir(), `spec-gen-api-test-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await createTestProject(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should create config and openspec directory', async () => {
    const result = await specGenInit({ rootPath: testDir });

    expect(result.created).toBe(true);
    expect(result.configPath).toBe('.spec-gen/config.json');
    expect(result.openspecPath).toBe('./openspec');
    expect(result.projectType).toBeTruthy();
  });

  it('should skip if config exists and force is false', async () => {
    // First init
    await specGenInit({ rootPath: testDir });
    // Second init without force
    const result = await specGenInit({ rootPath: testDir });

    expect(result.created).toBe(false);
  });

  it('should overwrite config when force is true', async () => {
    await specGenInit({ rootPath: testDir });
    const result = await specGenInit({ rootPath: testDir, force: true });

    expect(result.created).toBe(true);
  });

  it('should reject paths outside project root', async () => {
    await expect(
      specGenInit({ rootPath: testDir, openspecPath: '../../outside' })
    ).rejects.toThrow('OpenSpec path must be within the project directory');
  });

  it('should call onProgress with expected events', async () => {
    const events: ProgressEvent[] = [];
    await specGenInit({
      rootPath: testDir,
      onProgress: (event) => events.push(event),
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.phase === 'init')).toBe(true);
    expect(events.some(e => e.step === 'Detecting project type')).toBe(true);
    expect(events.some(e => e.status === 'complete')).toBe(true);
  });

  it('should detect project type correctly', async () => {
    const result = await specGenInit({ rootPath: testDir });
    // testDir has a package.json so should detect as Node.js
    expect(result.projectType.toLowerCase()).toContain('node');
  });

  it('should use custom openspec path', async () => {
    const result = await specGenInit({
      rootPath: testDir,
      openspecPath: './docs/specs',
    });

    expect(result.openspecPath).toBe('./docs/specs');
  });

  it('should add .spec-gen/ to .gitignore', async () => {
    await specGenInit({ rootPath: testDir });

    const { readFile } = await import('node:fs/promises');
    const gitignore = await readFile(join(testDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.spec-gen/');
  });
});

// ============================================================================
// TESTS: specGenAnalyze
// ============================================================================

describe('specGenAnalyze', () => {
  beforeEach(async () => {
    testDir = join(tmpdir(), `spec-gen-api-test-analyze-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await createTestProject(testDir);
    // Init first
    await specGenInit({ rootPath: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should analyze the codebase and return results', async () => {
    const result = await specGenAnalyze({ rootPath: testDir });

    expect(result.repoMap).toBeDefined();
    expect(result.depGraph).toBeDefined();
    expect(result.artifacts).toBeDefined();
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('should throw if no config exists', async () => {
    const emptyDir = join(tmpdir(), `spec-gen-api-test-empty-${Date.now()}`);
    await mkdir(emptyDir, { recursive: true });

    try {
      await expect(
        specGenAnalyze({ rootPath: emptyDir })
      ).rejects.toThrow('No spec-gen configuration found');
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('should skip recent analysis unless force is true', async () => {
    // First analysis
    const result1 = await specGenAnalyze({ rootPath: testDir });
    expect(result1.repoMap).toBeDefined();

    // Second analysis should skip (< 1 hour old)
    const events: ProgressEvent[] = [];
    await specGenAnalyze({
      rootPath: testDir,
      onProgress: (e) => events.push(e),
    });

    expect(events.some(e => e.status === 'skip')).toBe(true);

    // Force re-analysis
    const result3 = await specGenAnalyze({
      rootPath: testDir,
      force: true,
    });
    expect(result3.duration).toBeGreaterThanOrEqual(0);
  });

  it('should call onProgress with expected events', async () => {
    const events: ProgressEvent[] = [];
    await specGenAnalyze({
      rootPath: testDir,
      onProgress: (event) => events.push(event),
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events.every(e => e.phase === 'analyze')).toBe(true);
    expect(events.some(e => e.step.includes('Scanning'))).toBe(true);
    expect(events.some(e => e.step.includes('dependency graph'))).toBe(true);
  });
});

// ============================================================================
// TESTS: specGenDrift
// ============================================================================

describe('specGenDrift', () => {
  beforeEach(async () => {
    testDir = join(tmpdir(), `spec-gen-api-test-drift-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await createTestProject(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should throw if not a git repository', async () => {
    // testDir has no .git
    await specGenInit({ rootPath: testDir });
    await expect(
      specGenDrift({ rootPath: testDir })
    ).rejects.toThrow('Not a git repository');
  });

  it('should throw if no config exists', async () => {
    // Create a fake .git directory
    await mkdir(join(testDir, '.git'), { recursive: true });

    await expect(
      specGenDrift({ rootPath: testDir })
    ).rejects.toThrow('No spec-gen configuration found');
  });

  it('should throw if no specs exist', async () => {
    await mkdir(join(testDir, '.git'), { recursive: true });
    await specGenInit({ rootPath: testDir });

    // Remove openspec/specs to trigger the error
    const { rm: rmDir } = await import('node:fs/promises');
    await rmDir(join(testDir, 'openspec', 'specs'), { recursive: true, force: true });

    await expect(
      specGenDrift({ rootPath: testDir })
    ).rejects.toThrow('No specs found');
  });
});

// ============================================================================
// TESTS: API barrel exports
// ============================================================================

describe('API barrel exports', () => {
  it('should export all API functions', async () => {
    const api = await import('./index.js');

    expect(typeof api.specGenInit).toBe('function');
    expect(typeof api.specGenAnalyze).toBe('function');
    expect(typeof api.specGenGenerate).toBe('function');
    expect(typeof api.specGenVerify).toBe('function');
    expect(typeof api.specGenDrift).toBe('function');
    expect(typeof api.specGenRun).toBe('function');
  });
});
