/**
 * MCP tool handlers: decisions
 *
 * record_decision      — agent records an architectural decision during dev
 * list_decisions       — list pending/approved/all decisions
 * approve_decision     — approve a decision for syncing
 * reject_decision      — reject a decision
 * sync_decisions       — write approved decisions to spec.md files
 */

import { spawn } from 'node:child_process';
import { validateDirectory, sanitizeMcpError } from './utils.js';
import {
  loadDecisionStore,
  saveDecisionStore,
  upsertDecisions,
  patchDecision,
  makeDecisionId,
} from '../../decisions/store.js';
import { syncApprovedDecisions } from '../../decisions/syncer.js';
import { buildSpecMap, matchFileToDomains } from '../../../core/drift/spec-mapper.js';
import { readSpecGenConfig } from '../config-manager.js';
import { join } from 'node:path';
import { OPENSPEC_DIR } from '../../../constants.js';
import type { PendingDecision } from '../../../types/index.js';

function spawnConsolidateBackground(rootPath: string): void {
  // Resolve binary: prefer local build over global install (same order as pre-commit hook)
  const localDist = join(rootPath, 'dist', 'cli', 'index.js');
  const localBin = join(rootPath, 'node_modules', '.bin', 'spec-gen');

  import('node:fs').then(({ existsSync }) => {
    let cmd: string;
    let args: string[];
    if (existsSync(localBin)) {
      cmd = localBin; args = ['decisions', '--consolidate'];
    } else if (existsSync(localDist)) {
      cmd = process.execPath; args = [localDist, 'decisions', '--consolidate'];
    } else {
      cmd = 'spec-gen'; args = ['decisions', '--consolidate'];
    }
    const child = spawn(cmd, args, {
      cwd: rootPath,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }).catch(() => { /* ignore */ });
}

// ============================================================================
// record_decision
// ============================================================================

export async function handleRecordDecision(
  directory: string,
  title: string,
  rationale: string,
  consequences?: string,
  affectedFiles?: string[],
  supersedes?: string,
): Promise<unknown> {
  try {
    if (!title?.trim()) return { error: 'title is required and must not be empty.' };
    if (!rationale?.trim()) return { error: 'rationale is required and must not be empty.' };

    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    // Infer domain from affectedFiles via spec-map (best-effort, falls back to 'unknown')
    let primaryDomain = 'unknown';
    let inferredDomains: string[] = [];
    if (affectedFiles?.length) {
      try {
        const specGenConfig = await readSpecGenConfig(rootPath);
        const openspecPath = join(rootPath, specGenConfig?.openspecPath ?? OPENSPEC_DIR);
        const specMap = await buildSpecMap({ rootPath, openspecPath });
        const domainSet = new Set<string>();
        for (const file of affectedFiles) {
          for (const domain of matchFileToDomains(file, specMap)) {
            domainSet.add(domain);
          }
        }
        inferredDomains = [...domainSet];
        if (inferredDomains.length > 0) primaryDomain = inferredDomains[0];
      } catch {
        // spec-map unavailable — keep 'unknown'
      }
    }

    const id = makeDecisionId(store.sessionId, primaryDomain, title.trim());

    const decision: PendingDecision = {
      id,
      status: 'draft',
      title: title.trim(),
      rationale: rationale.trim(),
      consequences: consequences ?? '',
      proposedRequirement: null,
      affectedDomains: inferredDomains,
      affectedFiles: affectedFiles ?? [],
      supersedes,
      sessionId: store.sessionId,
      recordedAt: new Date().toISOString(),
      confidence: 'medium',
      syncedToSpecs: [],
    };

    const updated = upsertDecisions(store, [decision]);
    await saveDecisionStore(rootPath, updated);

    // Consolidate in background so commit-time gate is instant
    spawnConsolidateBackground(rootPath);

    return {
      id,
      message: `Decision recorded: "${title}". Consolidation running in background.`,
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// list_decisions
// ============================================================================

export async function handleListDecisions(
  directory: string,
  status?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    const decisions = status
      ? store.decisions.filter((d) => d.status === status)
      : store.decisions;

    return {
      total: decisions.length,
      sessionId: store.sessionId,
      updatedAt: store.updatedAt,
      decisions: decisions.map((d) => ({
        id: d.id,
        status: d.status,
        title: d.title,
        rationale: d.rationale,
        confidence: d.confidence,
        affectedDomains: d.affectedDomains,
        affectedFiles: d.affectedFiles,
        proposedRequirement: d.proposedRequirement,
        recordedAt: d.recordedAt,
        syncedToSpecs: d.syncedToSpecs,
      })),
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// approve_decision
// ============================================================================

export async function handleApproveDecision(
  directory: string,
  id: string,
  note?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    const decision = store.decisions.find((d) => d.id === id);
    if (!decision) return { error: `Decision ${id} not found.` };

    const updated = patchDecision(store, id, {
      status: 'approved',
      reviewedAt: new Date().toISOString(),
      reviewNote: note,
    });
    await saveDecisionStore(rootPath, updated);

    return { id, status: 'approved', title: decision.title };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// reject_decision
// ============================================================================

export async function handleRejectDecision(
  directory: string,
  id: string,
  note?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const store = await loadDecisionStore(rootPath);

    const decision = store.decisions.find((d) => d.id === id);
    if (!decision) return { error: `Decision ${id} not found.` };

    const updated = patchDecision(store, id, {
      status: 'rejected',
      reviewedAt: new Date().toISOString(),
      reviewNote: note,
    });
    await saveDecisionStore(rootPath, updated);

    return { id, status: 'rejected', title: decision.title };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ============================================================================
// sync_decisions
// ============================================================================

export async function handleSyncDecisions(
  directory: string,
  dryRun = false,
  id?: string,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);
    const specGenConfig = await readSpecGenConfig(rootPath);
    if (!specGenConfig) return { error: 'No spec-gen configuration found. Run spec-gen init first.' };

    const openspecPath = join(rootPath, specGenConfig.openspecPath ?? OPENSPEC_DIR);
    const specMap = await buildSpecMap({ rootPath, openspecPath });

    let store = await loadDecisionStore(rootPath);

    // If a specific id is given, promote it to approved before syncing
    if (id) {
      const decision = store.decisions.find((d) => d.id === id);
      if (!decision) return { error: `Decision ${id} not found.` };
      store = patchDecision(store, id, { status: 'approved' });
    }

    const { result } = await syncApprovedDecisions(store, {
      rootPath,
      openspecPath,
      specMap,
      dryRun,
    });

    return {
      synced: result.synced.map((d) => ({ id: d.id, title: d.title, specs: d.syncedToSpecs })),
      errors: result.errors,
      modifiedSpecs: result.modifiedSpecs,
      dryRun,
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}
