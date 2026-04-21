/**
 * spec-gen decisions — programmatic API
 *
 * Record, consolidate, and sync architectural decisions.
 * No side effects (no process.exit, no console.log).
 */

import { join } from 'node:path';
import {
  SPEC_GEN_DIR,
  SPEC_GEN_LOGS_SUBDIR,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  DECISIONS_EXTRACTION_MAX_FILES,
  DECISIONS_DIFF_MAX_CHARS,
} from '../constants.js';
import { fileExists } from '../utils/command-helpers.js';
import { readSpecGenConfig } from '../core/services/config-manager.js';
import { createLLMService } from '../core/services/llm-service.js';
import { isGitRepository, getChangedFiles, getFileDiff, getCommitMessages, resolveBaseRef, buildSpecMap } from '../core/drift/index.js';
import {
  loadDecisionStore,
  saveDecisionStore,
  upsertDecisions,
  patchDecision,
  makeDecisionId,
} from '../core/decisions/store.js';
import { consolidateDrafts } from '../core/decisions/consolidator.js';
import type { ProviderName } from '../utils/command-helpers.js';
import { verifyDecisions } from '../core/decisions/verifier.js';
import { syncApprovedDecisions } from '../core/decisions/syncer.js';
import type { PendingDecision, DecisionStore } from '../types/index.js';
import type { SyncResult } from '../core/decisions/syncer.js';
import type { BaseOptions, ProgressCallback } from './types.js';

function progress(cb: ProgressCallback | undefined, step: string, status: 'start' | 'complete' | 'skip', detail?: string): void {
  cb?.({ phase: 'decisions', step, status, detail });
}

// ============================================================================
// OPTION TYPES
// ============================================================================

export interface RecordDecisionOptions {
  rootPath?: string;
  title: string;
  rationale: string;
  consequences?: string;
  affectedFiles?: string[];
  supersedes?: string;
}

export interface ConsolidateOptions extends BaseOptions {
  provider?: string;
  model?: string;
  apiBase?: string;
  sslVerify?: boolean;
  baseRef?: string;
}

export interface SyncDecisionsOptions extends BaseOptions {
  ids?: string[];
  dryRun?: boolean;
}

export interface ConsolidateResult {
  verified: PendingDecision[];
  phantom: PendingDecision[];
  missing: Array<{ file: string; description: string }>;
  store: DecisionStore;
}

// ============================================================================
// RECORD
// ============================================================================

/**
 * Record a new architectural decision draft.
 * Called by agents during development (via MCP or directly).
 * Returns the ID of the recorded decision.
 */
export async function specGenRecordDecision(options: RecordDecisionOptions): Promise<{ id: string }> {
  const rootPath = options.rootPath ?? process.cwd();
  const store = await loadDecisionStore(rootPath);

  const domain = 'unknown';
  const id = makeDecisionId(store.sessionId, domain, options.title);

  const decision: PendingDecision = {
    id,
    status: 'draft',
    title: options.title,
    rationale: options.rationale,
    consequences: options.consequences ?? '',
    proposedRequirement: null,
    affectedDomains: [],
    affectedFiles: options.affectedFiles ?? [],
    supersedes: options.supersedes,
    sessionId: store.sessionId,
    recordedAt: new Date().toISOString(),
    confidence: 'medium',
    syncedToSpecs: [],
  };

  const updated = upsertDecisions(store, [decision]);
  await saveDecisionStore(rootPath, updated);

  return { id };
}

// ============================================================================
// CONSOLIDATE + VERIFY
// ============================================================================

/**
 * Consolidate draft decisions via LLM, then cross-verify against git diff.
 * Returns verified, phantom, and missing decision sets.
 */
export async function specGenConsolidateDecisions(
  options: ConsolidateOptions = {},
): Promise<ConsolidateResult> {
  const rootPath = options.rootPath ?? process.cwd();
  const { onProgress } = options;

  const specGenConfig = await readSpecGenConfig(rootPath);
  if (!specGenConfig) throw new Error('No spec-gen configuration found. Run specGenInit() first.');

  const providerEnv =
    process.env.ANTHROPIC_API_KEY ? 'anthropic' :
    process.env.GEMINI_API_KEY ? 'gemini' :
    process.env.OPENAI_COMPAT_API_KEY ? 'openai-compat' :
    process.env.OPENAI_API_KEY ? 'openai' : null;

  const provider = (options.provider ?? specGenConfig.generation?.provider ?? providerEnv) as string | undefined;
  if (!provider) throw new Error('No LLM provider configured. Set an API key or configure generation.provider.');

  const llm = createLLMService({
    provider: provider as ProviderName,
    model: options.model ?? specGenConfig.generation?.model,
    apiBase: options.apiBase ?? specGenConfig.llm?.apiBase,
    sslVerify: options.sslVerify ?? specGenConfig.llm?.sslVerify ?? true,
    enableLogging: true,
    logDir: join(rootPath, SPEC_GEN_DIR, SPEC_GEN_LOGS_SUBDIR),
  });

  const store = await loadDecisionStore(rootPath);

  const openspecPath = join(rootPath, specGenConfig.openspecPath ?? OPENSPEC_DIR);
  const specMap = await buildSpecMap({ rootPath, openspecPath }).catch(() => undefined);

  progress(onProgress, 'Consolidating drafts', 'start');
  const { decisions: consolidated, supersededIds } = await consolidateDrafts(store, llm, specMap);
  progress(onProgress, 'Consolidating drafts', 'complete', `${consolidated.length} decisions`);

  if (consolidated.length === 0) {
    return { verified: [], phantom: [], missing: [], store };
  }

  // Build combined diff + commit messages for verification
  let combinedDiff = '';
  let commitMessages = '';
  if (await isGitRepository(rootPath)) {
    progress(onProgress, 'Building git diff', 'start');
    try {
      const baseRef = await resolveBaseRef(rootPath, options.baseRef ?? 'auto');
      const gitResult = await getChangedFiles({ rootPath, baseRef, includeUnstaged: false });
      const relevant = gitResult.files.slice(0, DECISIONS_EXTRACTION_MAX_FILES);
      const diffs = await Promise.all(
        relevant.map((f) => getFileDiff(rootPath, f.path, baseRef, DECISIONS_DIFF_MAX_CHARS))
      );
      combinedDiff = diffs.join('\n\n');
      commitMessages = await getCommitMessages(rootPath, baseRef).catch(() => '');
      progress(onProgress, 'Building git diff', 'complete', `${relevant.length} files`);
    } catch {
      progress(onProgress, 'Building git diff', 'skip', 'diff unavailable');
    }
  }

  progress(onProgress, 'Verifying decisions', 'start');
  const { verified, phantom, missing } = combinedDiff
    ? await verifyDecisions(consolidated, combinedDiff, llm, commitMessages)
    : { verified: consolidated.map((d) => ({ ...d, status: 'verified' as const, confidence: 'medium' as const })), phantom: [], missing: [] };
  progress(onProgress, 'Verifying decisions', 'complete', `${verified.length} verified`);

  let updatedStore = { ...store };
  for (const id of supersededIds) {
    updatedStore = patchDecision(updatedStore, id, { status: 'rejected' });
  }
  updatedStore = upsertDecisions(updatedStore, [...verified, ...phantom]);
  await saveDecisionStore(rootPath, updatedStore);

  return { verified, phantom, missing, store: updatedStore };
}

// ============================================================================
// SYNC
// ============================================================================

/**
 * Sync all approved decisions into spec.md files and create ADRs.
 */
export async function specGenSyncDecisions(
  options: SyncDecisionsOptions = {},
): Promise<SyncResult> {
  const rootPath = options.rootPath ?? process.cwd();
  const { onProgress } = options;

  const specGenConfig = await readSpecGenConfig(rootPath);
  if (!specGenConfig) throw new Error('No spec-gen configuration found.');

  const openspecPath = join(rootPath, specGenConfig.openspecPath ?? OPENSPEC_DIR);
  const specsPath = join(openspecPath, OPENSPEC_SPECS_SUBDIR);
  if (!(await fileExists(specsPath))) throw new Error('No specs found. Run specGenGenerate() first.');

  const specMap = await buildSpecMap({ rootPath, openspecPath });
  let store = await loadDecisionStore(rootPath);

  // Optionally filter to specific IDs
  if (options.ids?.length) {
    store = {
      ...store,
      decisions: store.decisions.map((d) =>
        options.ids!.includes(d.id) && d.status !== 'approved'
          ? { ...d, status: 'approved' as const }
          : d,
      ),
    };
  }

  progress(onProgress, 'Syncing decisions', 'start');
  const { result } = await syncApprovedDecisions(store, {
    rootPath,
    openspecPath,
    specMap,
    dryRun: options.dryRun,
  });
  progress(onProgress, 'Syncing decisions', 'complete', `${result.synced.length} synced`);

  return result;
}
