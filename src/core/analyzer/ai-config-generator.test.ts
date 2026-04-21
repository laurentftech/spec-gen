/**
 * AI Config Generator Tests
 *
 * Tests for generateAiConfigs() using real filesystem temp dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateAiConfigs } from './ai-config-generator.js';

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `ai-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================================
// TESTS
// ============================================================================

describe('generateAiConfigs', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('creates all 7 files when none exist and returns their relative paths', async () => {
    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
    });

    const rels = results.map(r => r.rel);
    expect(results).toHaveLength(7);
    expect(results.every(r => r.created)).toBe(true);
    expect(rels).toContain('CLAUDE.md');
    expect(rels).toContain('AGENTS.md');
    expect(rels).toContain('.cursorrules');
    expect(rels).toContain('.clinerules/spec-gen.md');
    expect(rels).toContain('.github/copilot-instructions.md');
    expect(rels).toContain('.windsurf/rules.md');
    expect(rels).toContain('.vibe/skills/spec-gen.md');
  });

  it('skips files that already exist — all have created=false on second call', async () => {
    // First call creates all files
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
    });

    // Second call: all files still returned, but created=false
    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
    });

    expect(results).toHaveLength(7);
    expect(results.every(r => !r.created)).toBe(true);
  });

  it('respects tools filter — tools: ["claude"] creates only CLAUDE.md', async () => {
    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
      tools: ['claude'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].rel).toBe('CLAUDE.md');
    expect(results[0].created).toBe(true);
  });

  it('Claude format uses @analysisDir/CODEBASE.md reference', async () => {
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
      tools: ['claude'],
    });

    const content = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('@.spec-gen/analysis/CODEBASE.md');
    // Should NOT use HTML comment
    expect(content).not.toContain('<!--');
  });

  it('non-Claude format uses HTML comment reference', async () => {
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
      tools: ['cursor'],
    });

    const content = await readFile(join(tmpDir, '.cursorrules'), 'utf-8');
    expect(content).toContain('<!-- Import or paste .spec-gen/analysis/CODEBASE.md here');
    expect(content).not.toContain('@.spec-gen/analysis/CODEBASE.md');
  });

  it('content contains project name', async () => {
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'awesome-app',
      tools: ['claude'],
    });

    const content = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('awesome-app');
  });

  it('content contains MCP workflow', async () => {
    await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
      tools: ['cursor'],
    });

    const content = await readFile(join(tmpDir, '.cursorrules'), 'utf-8');
    expect(content).toContain('spec-gen MCP workflow');
    expect(content).toContain('orient');
    expect(content).toContain('search_code');
  });

  it('creates nested directory for .clinerules/spec-gen.md', async () => {
    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
      tools: ['cline'],
    });

    expect(results[0].rel).toBe('.clinerules/spec-gen.md');
    expect(results[0].created).toBe(true);
    const content = await readFile(join(tmpDir, '.clinerules', 'spec-gen.md'), 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('creates nested directory for .github/copilot-instructions.md', async () => {
    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
      tools: ['copilot'],
    });

    expect(results[0].rel).toBe('.github/copilot-instructions.md');
    expect(results[0].created).toBe(true);
    const content = await readFile(join(tmpDir, '.github', 'copilot-instructions.md'), 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('empty tools: [] produces no files', async () => {
    const created = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
      tools: [],
    });

    expect(created).toHaveLength(0);
  });

  it('skips only pre-existing files, creates the rest', async () => {
    // Create only CLAUDE.md ahead of time
    await writeFile(join(tmpDir, 'CLAUDE.md'), 'existing content', 'utf-8');

    const results = await generateAiConfigs({
      rootDir: tmpDir,
      analysisDir: '.spec-gen/analysis',
      projectName: 'my-project',
    });

    // All 7 returned, CLAUDE.md has created=false, the rest created=true
    expect(results).toHaveLength(7);
    const claudeResult = results.find(r => r.rel === 'CLAUDE.md');
    expect(claudeResult?.created).toBe(false);
    expect(results.filter(r => r.created)).toHaveLength(6);

    // Existing file content should be unchanged
    const content = await readFile(join(tmpDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toBe('existing content');
  });
});
