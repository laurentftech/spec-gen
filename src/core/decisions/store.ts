/**
 * Decision store — CRUD for .spec-gen/decisions/pending.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import {
  SPEC_GEN_DIR,
  SPEC_GEN_DECISIONS_SUBDIR,
  DECISIONS_PENDING_FILE,
} from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';
import type { PendingDecision, DecisionStore, DecisionStatus } from '../../types/index.js';

export function decisionsDir(rootPath: string): string {
  return join(rootPath, SPEC_GEN_DIR, SPEC_GEN_DECISIONS_SUBDIR);
}

export async function loadDecisionStore(rootPath: string): Promise<DecisionStore> {
  const path = join(decisionsDir(rootPath), DECISIONS_PENDING_FILE);
  if (!(await fileExists(path))) {
    return emptyStore();
  }
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as DecisionStore;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warning(
        `decisions store: failed to read ${path} (${(err as Error).message}) — starting fresh`
      );
    }
    return emptyStore();
  }
}

export async function saveDecisionStore(rootPath: string, store: DecisionStore): Promise<void> {
  const dir = decisionsDir(rootPath);
  await mkdir(dir, { recursive: true });
  const updated: DecisionStore = { ...store, updatedAt: new Date().toISOString() };
  await writeFile(
    join(dir, DECISIONS_PENDING_FILE),
    JSON.stringify(updated, null, 2) + '\n',
    'utf-8'
  );
}

/**
 * Merge incoming decisions into the store, deduplicating by id.
 * Existing decisions are never overwritten.
 */
export function upsertDecisions(store: DecisionStore, incoming: PendingDecision[]): DecisionStore {
  const byId = new Map(store.decisions.map((d) => [d.id, d]));
  for (const d of incoming) {
    if (!byId.has(d.id)) byId.set(d.id, d);
  }
  return { ...store, decisions: [...byId.values()] };
}

/**
 * Merge incoming decisions into the store, always overwriting by id.
 * Use this for consolidation output — consolidated decisions share IDs with
 * their original drafts (makeDecisionId is deterministic), so upsertDecisions
 * would silently no-op after patchDecision marks the originals rejected.
 */
export function replaceDecisions(store: DecisionStore, incoming: PendingDecision[]): DecisionStore {
  const byId = new Map(store.decisions.map((d) => [d.id, d]));
  for (const d of incoming) {
    byId.set(d.id, d);
  }
  return { ...store, decisions: [...byId.values()] };
}

/** Patch a single decision by id. Returns the updated store (not yet saved). */
export function patchDecision(
  store: DecisionStore,
  id: string,
  patch: Partial<PendingDecision>
): DecisionStore {
  return {
    ...store,
    decisions: store.decisions.map((d) => (d.id === id ? { ...d, ...patch } : d)),
  };
}

export function getDecisionsByStatus(
  store: DecisionStore,
  status: DecisionStatus
): PendingDecision[] {
  return store.decisions.filter((d) => d.status === status);
}

export function getDecisionCount(store: DecisionStore): number {
  return store.decisions.length;
}

/** Status blocks the commit gate until resolved. */
export function isBlockingStatus(status: DecisionStatus): boolean {
  return status === 'verified' || status === 'approved';
}

/** Status requires a --sync run before committing. */
export function requiresSync(status: DecisionStatus): boolean {
  return status === 'approved';
}

/** Statuses excluded from the "activeDecisions" gate guard. */
export const INACTIVE_STATUSES: ReadonlySet<DecisionStatus> = new Set([
  'rejected', 'synced', 'phantom',
]);

/** Drop all inactive decisions — their content is already in ADRs / spec.md. */
export function purgeInactiveDecisions(store: DecisionStore): DecisionStore {
  return {
    ...store,
    decisions: store.decisions.filter((d) => !INACTIVE_STATUSES.has(d.status)),
  };
}

/** Stable 8-char ID derived from session + domain + title. */
export function makeDecisionId(sessionId: string, domain: string, title: string): string {
  return createHash('sha256').update(`${sessionId}:${domain}:${title}`).digest('hex').slice(0, 8);
}

/** Generate a new session ID for a commit cycle. */
export function newSessionId(): string {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12);
}

function emptyStore(): DecisionStore {
  return {
    version: '1',
    sessionId: newSessionId(),
    updatedAt: new Date().toISOString(),
    decisions: [],
  };
}
