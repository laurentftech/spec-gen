import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// MOCK validateDirectory
// ============================================================================

// We mock validateDirectory so tests don't need a real .spec-gen/config.json
vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (dir: string) => dir),
}));

// ============================================================================
// TESTS — handleListSpecDomains
// ============================================================================

describe('handleListSpecDomains', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-semantic-test-'));
  });

  it('returns empty domains when openspec/specs/ does not exist', async () => {
    const { handleListSpecDomains } = await import('./semantic.js');
    const result = await handleListSpecDomains(tmpDir) as { domains: string[]; note?: string };
    expect(result.domains).toEqual([]);
    expect(result.note).toContain('No openspec/specs/');
  });

  it('returns the list of domains that have a spec.md', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs');
    await mkdir(join(specsDir, 'auth'), { recursive: true });
    await mkdir(join(specsDir, 'crawler'), { recursive: true });
    await mkdir(join(specsDir, 'empty-domain'), { recursive: true }); // no spec.md
    await writeFile(join(specsDir, 'auth', 'spec.md'), '# Auth', 'utf-8');
    await writeFile(join(specsDir, 'crawler', 'spec.md'), '# Crawler', 'utf-8');

    const { handleListSpecDomains } = await import('./semantic.js');
    const result = await handleListSpecDomains(tmpDir) as { domains: string[]; count: number };
    expect(result.domains).toContain('auth');
    expect(result.domains).toContain('crawler');
    expect(result.domains).not.toContain('empty-domain');
    expect(result.count).toBe(2);
  });

  it('returns count matching number of domains', async () => {
    const specsDir = join(tmpDir, 'openspec', 'specs');
    await mkdir(join(specsDir, 'billing'), { recursive: true });
    await writeFile(join(specsDir, 'billing', 'spec.md'), '# Billing', 'utf-8');

    const { handleListSpecDomains } = await import('./semantic.js');
    const result = await handleListSpecDomains(tmpDir) as { domains: string[]; count: number };
    expect(result.count).toBe(result.domains.length);
  });
});

// ============================================================================
// TESTS — handleSearchSpecs (error paths — no LanceDB needed)
// ============================================================================

describe('handleSearchSpecs', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-search-specs-test-'));
  });

  it('returns an error object when no spec index exists', async () => {
    // Mock SpecVectorIndex.exists to return false
    vi.doMock('../../analyzer/spec-vector-index.js', () => ({
      SpecVectorIndex: {
        exists: vi.fn().mockReturnValue(false),
        build: vi.fn(),
        search: vi.fn(),
      },
    }));

    const { handleSearchSpecs } = await import('./semantic.js');
    const result = await handleSearchSpecs(tmpDir, 'email validation') as { error: string };
    expect(result.error).toContain('No spec index found');
    expect(result.error).toContain('--reindex-specs');
  });
});
