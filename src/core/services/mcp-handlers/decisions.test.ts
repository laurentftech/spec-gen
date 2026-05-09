/**
 * Tests for MCP decision handlers:
 *   handleRecordDecision, handleListDecisions,
 *   handleApproveDecision, handleRejectDecision, handleSyncDecisions
 *
 * Strategy: mock validateDirectory to return tmpDir so real store file I/O
 * runs against the temp directory. Mock spawn (background consolidation),
 * syncApprovedDecisions, buildSpecMap, and readSpecGenConfig.
 */

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

import { vi } from 'vitest';

vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
  return {
    ...actual,
    validateDirectory: vi.fn(async (dir: string) => dir),
  };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('../config-manager.js', () => ({
  readSpecGenConfig: vi.fn(async () => null),
}));

vi.mock('../../../core/drift/spec-mapper.js', () => ({
  buildSpecMap: vi.fn(async () => ({})),
  matchFileToDomains: vi.fn(() => []),
}));

vi.mock('../../decisions/syncer.js', () => ({
  syncApprovedDecisions: vi.fn(async (store: unknown) => ({
    store,
    result: { synced: [], errors: [], modifiedSpecs: [] },
  })),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DecisionStore, PendingDecision } from '../../../types/index.js';
import {
  SPEC_GEN_DIR,
  SPEC_GEN_DECISIONS_SUBDIR,
  DECISIONS_PENDING_FILE,
} from '../../../constants.js';
import {
  handleRecordDecision,
  handleListDecisions,
  handleApproveDecision,
  handleRejectDecision,
  handleSyncDecisions,
} from './decisions.js';
import { validateDirectory } from './utils.js';
import { readSpecGenConfig } from '../config-manager.js';
import { syncApprovedDecisions } from '../../decisions/syncer.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'abc12345',
    status: 'draft',
    title: 'Use SQLite for edges',
    rationale: 'JSON too large at scale',
    consequences: 'Requires migration',
    proposedRequirement: null,
    affectedDomains: [],
    affectedFiles: [],
    sessionId: 'test-session',
    recordedAt: '2026-01-01T00:00:00.000Z',
    confidence: 'medium',
    syncedToSpecs: [],
    ...overrides,
  };
}

function makeStore(overrides: Partial<DecisionStore> = {}): DecisionStore {
  return {
    version: '1',
    sessionId: 'test-session',
    updatedAt: '2026-01-01T00:00:00.000Z',
    decisions: [],
    ...overrides,
  };
}

async function writeStore(rootPath: string, store: DecisionStore): Promise<void> {
  const dir = join(rootPath, SPEC_GEN_DIR, SPEC_GEN_DECISIONS_SUBDIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, DECISIONS_PENDING_FILE), JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

async function readStore(rootPath: string): Promise<DecisionStore> {
  const path = join(rootPath, SPEC_GEN_DIR, SPEC_GEN_DECISIONS_SUBDIR, DECISIONS_PENDING_FILE);
  return JSON.parse(await readFile(path, 'utf-8')) as DecisionStore;
}

// ── handleRecordDecision ──────────────────────────────────────────────────────

describe('handleRecordDecision', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-decisions-test-'));
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
    vi.clearAllMocks();
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns error when title is empty', async () => {
    const result = await handleRecordDecision(tmpDir, '', 'some rationale') as { error: string };
    expect(result.error).toMatch(/title is required/);
  });

  it('returns error when title is whitespace only', async () => {
    const result = await handleRecordDecision(tmpDir, '   ', 'some rationale') as { error: string };
    expect(result.error).toMatch(/title is required/);
  });

  it('returns error when rationale is empty', async () => {
    const result = await handleRecordDecision(tmpDir, 'My decision', '') as { error: string };
    expect(result.error).toMatch(/rationale is required/);
  });

  it('records a draft decision and returns an id', async () => {
    const result = await handleRecordDecision(tmpDir, 'Use SQLite', 'JSON too big') as { id: string; message: string };
    expect(result.id).toHaveLength(8);
    expect(result.message).toContain('Use SQLite');
  });

  it('persists the decision with draft status to disk', async () => {
    await handleRecordDecision(tmpDir, 'Use SQLite', 'JSON too big');
    const store = await readStore(tmpDir);
    expect(store.decisions).toHaveLength(1);
    expect(store.decisions[0].title).toBe('Use SQLite');
    expect(store.decisions[0].status).toBe('draft');
    expect(store.decisions[0].rationale).toBe('JSON too big');
  });

  it('stores consequences and affectedFiles when provided', async () => {
    await handleRecordDecision(
      tmpDir, 'Use SQLite', 'JSON too big',
      'needs migration', ['src/store.ts'],
    );
    const store = await readStore(tmpDir);
    expect(store.decisions[0].consequences).toBe('needs migration');
    expect(store.decisions[0].affectedFiles).toEqual(['src/store.ts']);
  });

  it('stores supersedes id when provided', async () => {
    await handleRecordDecision(
      tmpDir, 'Use SQLite', 'JSON too big',
      undefined, undefined, 'deadbeef',
    );
    const store = await readStore(tmpDir);
    expect(store.decisions[0].supersedes).toBe('deadbeef');
  });
});

// ── handleListDecisions ───────────────────────────────────────────────────────

describe('handleListDecisions', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-decisions-test-'));
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns empty list when no store exists', async () => {
    const result = await handleListDecisions(tmpDir) as { total: number; decisions: unknown[] };
    expect(result.total).toBe(0);
    expect(result.decisions).toEqual([]);
  });

  it('returns all decisions when no status filter', async () => {
    const store = makeStore({
      decisions: [
        makeDecision({ id: 'aaa11111', status: 'draft', title: 'Decision A' }),
        makeDecision({ id: 'bbb22222', status: 'approved', title: 'Decision B' }),
      ],
    });
    await writeStore(tmpDir, store);
    const result = await handleListDecisions(tmpDir) as { total: number; decisions: Array<{ id: string }> };
    expect(result.total).toBe(2);
    expect(result.decisions.map((d) => d.id)).toEqual(['aaa11111', 'bbb22222']);
  });

  it('filters decisions by status', async () => {
    const store = makeStore({
      decisions: [
        makeDecision({ id: 'aaa11111', status: 'draft', title: 'Draft' }),
        makeDecision({ id: 'bbb22222', status: 'approved', title: 'Approved' }),
      ],
    });
    await writeStore(tmpDir, store);
    const result = await handleListDecisions(tmpDir, 'approved') as { total: number; decisions: Array<{ id: string; status: string }> };
    expect(result.total).toBe(1);
    expect(result.decisions[0].id).toBe('bbb22222');
    expect(result.decisions[0].status).toBe('approved');
  });

  it('returns mapped fields including proposedRequirement and syncedToSpecs', async () => {
    const store = makeStore({
      decisions: [makeDecision({ proposedRequirement: 'REQ-001', syncedToSpecs: ['services'] })],
    });
    await writeStore(tmpDir, store);
    const result = await handleListDecisions(tmpDir) as { decisions: Array<Record<string, unknown>> };
    const d = result.decisions[0];
    expect(d.proposedRequirement).toBe('REQ-001');
    expect(d.syncedToSpecs).toEqual(['services']);
  });
});

// ── handleApproveDecision ─────────────────────────────────────────────────────

describe('handleApproveDecision', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-decisions-test-'));
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns error when decision id is not found', async () => {
    await writeStore(tmpDir, makeStore());
    const result = await handleApproveDecision(tmpDir, 'notfound') as { error: string };
    expect(result.error).toMatch(/notfound/);
  });

  it('approves a draft decision and returns id + status + title', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'draft', title: 'Use SQLite' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    const result = await handleApproveDecision(tmpDir, 'abc12345') as { id: string; status: string; title: string };
    expect(result.id).toBe('abc12345');
    expect(result.status).toBe('approved');
    expect(result.title).toBe('Use SQLite');
  });

  it('persists the approved status to disk', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'draft' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    await handleApproveDecision(tmpDir, 'abc12345', 'LGTM');
    const store = await readStore(tmpDir);
    expect(store.decisions[0].status).toBe('approved');
    expect(store.decisions[0].reviewNote).toBe('LGTM');
  });
});

// ── handleRejectDecision ──────────────────────────────────────────────────────

describe('handleRejectDecision', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-decisions-test-'));
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
  });

  it('returns error when decision id is not found', async () => {
    await writeStore(tmpDir, makeStore());
    const result = await handleRejectDecision(tmpDir, 'notfound') as { error: string };
    expect(result.error).toMatch(/notfound/);
  });

  it('rejects a decision and returns id + status + title', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'draft', title: 'Use JSON' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    const result = await handleRejectDecision(tmpDir, 'abc12345', 'Too slow') as { id: string; status: string; title: string };
    expect(result.id).toBe('abc12345');
    expect(result.status).toBe('rejected');
    expect(result.title).toBe('Use JSON');
  });

  it('persists the rejected status and note to disk', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'draft' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    await handleRejectDecision(tmpDir, 'abc12345', 'Bad idea');
    const store = await readStore(tmpDir);
    expect(store.decisions[0].status).toBe('rejected');
    expect(store.decisions[0].reviewNote).toBe('Bad idea');
  });
});

// ── handleSyncDecisions ───────────────────────────────────────────────────────

describe('handleSyncDecisions', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'spec-gen-decisions-test-'));
    vi.mocked(validateDirectory).mockResolvedValue(tmpDir);
    vi.mocked(readSpecGenConfig).mockResolvedValue(null);
  });

  it('returns error when no spec-gen config exists', async () => {
    const result = await handleSyncDecisions(tmpDir) as { error: string };
    expect(result.error).toMatch(/No spec-gen configuration/);
  });

  it('calls syncApprovedDecisions with rootPath and dryRun flag', async () => {
    vi.mocked(readSpecGenConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    await writeStore(tmpDir, makeStore());

    await handleSyncDecisions(tmpDir, true);
    expect(syncApprovedDecisions).toHaveBeenCalledWith(
      expect.objectContaining({ decisions: [] }),
      expect.objectContaining({ rootPath: tmpDir, dryRun: true }),
    );
  });

  it('returns synced/errors/modifiedSpecs and dryRun from syncer result', async () => {
    vi.mocked(readSpecGenConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    vi.mocked(syncApprovedDecisions).mockResolvedValue({
      store: makeStore(),
      result: {
        synced: [{ id: 'abc12345', title: 'Use SQLite', syncedToSpecs: ['services'] } as PendingDecision],
        errors: [],
        modifiedSpecs: ['openspec/specs/services/spec.md'],
      },
    });
    await writeStore(tmpDir, makeStore());

    const result = await handleSyncDecisions(tmpDir, false) as {
      synced: Array<{ id: string; title: string; specs: string[] }>;
      errors: unknown[];
      modifiedSpecs: string[];
      dryRun: boolean;
    };
    expect(result.dryRun).toBe(false);
    expect(result.synced).toHaveLength(1);
    expect(result.synced[0].id).toBe('abc12345');
    expect(result.modifiedSpecs).toEqual(['openspec/specs/services/spec.md']);
  });

  it('promotes a specific decision to approved before syncing when id provided', async () => {
    vi.mocked(readSpecGenConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    const decision = makeDecision({ id: 'abc12345', status: 'draft' });
    await writeStore(tmpDir, makeStore({ decisions: [decision] }));

    await handleSyncDecisions(tmpDir, false, 'abc12345');
    expect(syncApprovedDecisions).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.arrayContaining([
          expect.objectContaining({ id: 'abc12345', status: 'approved' }),
        ]),
      }),
      expect.anything(),
    );
  });

  it('returns error when specific id not found', async () => {
    vi.mocked(readSpecGenConfig).mockResolvedValue({ openspecPath: 'openspec' } as never);
    await writeStore(tmpDir, makeStore());

    const result = await handleSyncDecisions(tmpDir, false, 'notfound') as { error: string };
    expect(result.error).toMatch(/notfound/);
  });
});
