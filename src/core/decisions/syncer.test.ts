/**
 * Tests for decision syncer — pure helpers + dryRun integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncApprovedDecisions } from './syncer.js';
import type { PendingDecision, DecisionStore, SpecMap } from '../../types/index.js';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    section: vi.fn(),
    discovery: vi.fn(),
    analysis: vi.fn(),
    blank: vi.fn(),
  },
}));

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>();
  return { ...actual, saveDecisionStore: vi.fn() };
});

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `decisions-syncer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'aaaabbbb',
    status: 'approved',
    title: 'Use Redis for caching',
    rationale: 'Reduces DB load by moving session data to an in-memory store.',
    consequences: 'Requires Redis in production. Session TTL must be managed.',
    proposedRequirement: 'The system SHALL use Redis for session caching.',
    affectedDomains: ['services'],
    affectedFiles: ['src/services/cache.ts'],
    confidence: 'high',
    sessionId: 'sess-001',
    recordedAt: '2026-04-18T10:00:00Z',
    syncedToSpecs: [],
    ...overrides,
  };
}

function makeStore(decisions: PendingDecision[]): DecisionStore {
  return {
    version: '1',
    sessionId: 'sess-001',
    updatedAt: '2026-04-18T10:00:00Z',
    decisions,
  };
}

function makeSpecMap(domain: string, specPath: string): SpecMap {
  const byDomain = new Map<string, { specPath: string; sourcePaths: string[] }>();
  byDomain.set(domain, { specPath, sourcePaths: [] });
  return {
    byDomain,
    byFile: new Map(),
  } as unknown as SpecMap;
}

// Minimal spec.md content with required header and sections
const MINIMAL_SPEC = `# Services Spec

> Source files: src/services/old.ts

## Requirements

### Requirement: ExistingReq

The system SHALL do something.

## Technical Notes

Notes here.
`;

// ============================================================================
// appendToSpec — pure integration via syncApprovedDecisions dryRun:false
// ============================================================================

describe('syncApprovedDecisions — filesystem writes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('appends requirement and decision section to spec', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const decision = makeDecision();
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    expect(result.synced).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
    expect(result.modifiedSpecs).toContain('openspec/specs/services/spec.md');

    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('### Requirement: UseRedisForCaching');
    expect(content).toContain('The system SHALL use Redis for session caching.');
    expect(content).toContain('## Decisions');
    expect(content).toContain('### Use Redis for caching');
    expect(content).toContain('**ID:** aaaabbbb');
  });

  it('does not duplicate "The system SHALL" prefix', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    // proposedRequirement already starts with "The system SHALL"
    const decision = makeDecision({
      proposedRequirement: 'The system SHALL use Redis for session caching.',
    });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const content = await readFile(specPath, 'utf-8');
    const occurrences = (content.match(/The system SHALL use Redis/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('adds new source files to > Source files: header', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const decision = makeDecision({ affectedFiles: ['src/services/cache.ts', 'src/services/session.ts'] });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('src/services/cache.ts');
    expect(content).toContain('src/services/session.ts');
  });

  it('does not re-add already present source files', async () => {
    const specWithFile = MINIMAL_SPEC.replace(
      '> Source files: src/services/old.ts',
      '> Source files: src/services/old.ts, src/services/cache.ts',
    );
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, specWithFile, 'utf-8');

    const decision = makeDecision({ affectedFiles: ['src/services/cache.ts'] });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const content = await readFile(specPath, 'utf-8');
    const occurrences = (content.match(/src\/services\/cache\.ts/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('skips decisions where domain not found in specMap (logs warning)', async () => {
    const { logger } = await import('../../utils/logger.js');
    const decision = makeDecision({ affectedDomains: ['nonexistent-domain'] });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    expect(result.synced).toHaveLength(1);
    expect(result.modifiedSpecs).toHaveLength(0);
    expect(logger.warning).toHaveBeenCalledWith(
      expect.stringContaining('nonexistent-domain'),
    );
  });

  it('dry-run returns modifiedSpecs without writing', async () => {
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, MINIMAL_SPEC, 'utf-8');

    const decision = makeDecision();
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
      dryRun: true,
    });

    expect(result.modifiedSpecs).toContain('openspec/specs/services/spec.md');

    // File must be unchanged
    const content = await readFile(specPath, 'utf-8');
    expect(content).toBe(MINIMAL_SPEC);
  });

  it('skips non-approved decisions', async () => {
    const decision = makeDecision({ status: 'verified' });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    expect(result.synced).toHaveLength(0);
  });
});

// ============================================================================
// isArchitectural — 2-keyword threshold
// ============================================================================

describe('isArchitectural — exported via dryRun ADR path', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates ADR placeholder in dryRun for architectural decisions', async () => {
    // "authentication" + "database" — 2 keywords → architectural
    const decision = makeDecision({
      title: 'Authentication database schema',
      rationale: 'We chose PostgreSQL for authentication and database storage.',
    });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(specDir, 'spec.md'), MINIMAL_SPEC, 'utf-8');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
      dryRun: true,
    });

    expect(result.modifiedSpecs.some((p) => p.startsWith('openspec/decisions/adr-'))).toBe(true);
  });

  it('does not create ADR for non-architectural decisions', async () => {
    // No keyword matches at all
    const decision = makeDecision({
      title: 'Add retry logic',
      rationale: 'Retry failed HTTP requests up to 3 times.',
    });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(specDir, 'spec.md'), MINIMAL_SPEC, 'utf-8');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
      dryRun: true,
    });

    expect(result.modifiedSpecs.every((p) => !p.startsWith('openspec/decisions/adr-'))).toBe(true);
  });

  it('requires 2 keyword matches — single match is not architectural', async () => {
    // Only "authentication" — 1 keyword → not architectural
    const decision = makeDecision({
      title: 'Add authentication endpoint',
      rationale: 'Standard JWT-based login flow.',
    });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(specDir, 'spec.md'), MINIMAL_SPEC, 'utf-8');

    const { result } = await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
      dryRun: true,
    });

    expect(result.modifiedSpecs.every((p) => !p.startsWith('openspec/decisions/adr-'))).toBe(true);
  });
});

// ============================================================================
// appendDecisionSection — creates ## Decisions header if absent
// ============================================================================

describe('appendDecisionSection via full sync', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates ## Decisions section when absent', async () => {
    const spec = `# My Spec\n\n## Requirements\n\nSome req.\n`;
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, spec, 'utf-8');

    const decision = makeDecision({ proposedRequirement: null });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('## Decisions');
    expect(content).toContain('### Use Redis for caching');
  });

  it('appends to existing ## Decisions section', async () => {
    const spec = `# My Spec\n\n## Decisions\n\n### Old Decision\n\nSome old decision.\n`;
    const specDir = join(tmpDir, 'openspec', 'specs', 'services');
    await mkdir(specDir, { recursive: true });
    const specPath = join(specDir, 'spec.md');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(specPath, spec, 'utf-8');

    const decision = makeDecision({ proposedRequirement: null });
    const store = makeStore([decision]);
    const specMap = makeSpecMap('services', 'openspec/specs/services/spec.md');

    await syncApprovedDecisions(store, {
      rootPath: tmpDir,
      openspecPath: join(tmpDir, 'openspec'),
      specMap,
    });

    const content = await readFile(specPath, 'utf-8');
    expect(content).toContain('### Old Decision');
    expect(content).toContain('### Use Redis for caching');
    // Only one ## Decisions header
    const occurrences = (content.match(/^## Decisions/gm) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
