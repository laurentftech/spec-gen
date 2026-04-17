/**
 * spec-gen decisions command
 *
 * Agent-recorded architectural decision workflow:
 *   record (via MCP) → consolidate → verify → approve → sync → spec.md
 *
 * Can be installed as a pre-commit hook that gates commits until decisions
 * are reviewed.
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { fileExists, parseList, resolveLLMProvider } from '../../utils/command-helpers.js';
import { readSpecGenConfig } from '../../core/services/config-manager.js';
import { createLLMService } from '../../core/services/llm-service.js';
import { isGitRepository, getChangedFiles, getFileDiff, resolveBaseRef } from '../../core/drift/index.js';
import { buildSpecMap } from '../../core/drift/index.js';
import {
  loadDecisionStore,
  saveDecisionStore,
  upsertDecisions,
  patchDecision,
  getDecisionsByStatus,
  makeDecisionId,
  newSessionId,
} from '../../core/decisions/store.js';
import { consolidateDrafts } from '../../core/decisions/consolidator.js';
import { verifyDecisions } from '../../core/decisions/verifier.js';
import { syncApprovedDecisions } from '../../core/decisions/syncer.js';
import {
  SPEC_GEN_DIR,
  SPEC_GEN_LOGS_SUBDIR,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  DECISIONS_EXTRACTION_MAX_FILES,
  DECISIONS_DIFF_MAX_CHARS,
  SPEC_GEN_CONFIG_REL_PATH,
} from '../../constants.js';
import type { PendingDecision } from '../../types/index.js';

// ============================================================================
// HOOK MANAGEMENT
// ============================================================================

const HOOK_MARKER = '# spec-gen-decisions-hook';

const HOOK_CONTENT = `${HOOK_MARKER}
# Gate commits until architectural decisions are reviewed.
# Installed by: spec-gen decisions --install-hook

SPEC_GEN=$(command -v spec-gen 2>/dev/null)
if [ -n "$SPEC_GEN" ]; then
  "$SPEC_GEN" decisions --consolidate --gate 2>&1
  DECISIONS_EXIT=$?
  if [ $DECISIONS_EXIT -ne 0 ]; then
    exit $DECISIONS_EXIT
  fi
fi
# end-spec-gen-decisions-hook
`;

async function installPreCommitHook(rootPath: string): Promise<void> {
  const hooksDir = join(rootPath, '.git', 'hooks');
  const hookPath = join(hooksDir, 'pre-commit');

  if (!(await fileExists(join(rootPath, '.git')))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 1;
    return;
  }

  await mkdir(hooksDir, { recursive: true });

  let existingContent = '';
  if (await fileExists(hookPath)) {
    existingContent = await readFile(hookPath, 'utf-8');
    if (existingContent.includes(HOOK_MARKER)) {
      logger.success('Pre-commit hook already installed.');
      return;
    }
    logger.discovery('Existing pre-commit hook found. Appending decisions gate.');
    await writeFile(hookPath, existingContent.trimEnd() + '\n\n' + HOOK_CONTENT, 'utf-8');
  } else {
    await writeFile(hookPath, '#!/bin/sh\n\n' + HOOK_CONTENT, 'utf-8');
  }

  await chmod(hookPath, 0o755);
  logger.success('Pre-commit hook installed at .git/hooks/pre-commit');
  logger.discovery('Commits will be gated until decisions are approved. Use --no-verify to skip.');
}

async function uninstallPreCommitHook(rootPath: string): Promise<void> {
  const hookPath = join(rootPath, '.git', 'hooks', 'pre-commit');

  if (!(await fileExists(hookPath))) {
    logger.warning('No pre-commit hook found.');
    return;
  }

  const content = await readFile(hookPath, 'utf-8');
  if (!content.includes(HOOK_MARKER)) {
    logger.warning('Pre-commit hook does not contain spec-gen decisions gate.');
    return;
  }

  const newContent = content
    .replace(/\n*# spec-gen-decisions-hook[\s\S]*?# end-spec-gen-decisions-hook\n*/g, '')
    .trim();

  if (!newContent || newContent === '#!/bin/sh') {
    const { unlink } = await import('node:fs/promises');
    await unlink(hookPath);
    logger.success('Pre-commit hook removed (file deleted — was only spec-gen).');
  } else {
    await writeFile(hookPath, newContent + '\n', 'utf-8');
    logger.success('Spec-gen decisions gate removed from pre-commit hook.');
  }
}

// ============================================================================
// DISPLAY HELPERS
// ============================================================================

function displayDecision(d: PendingDecision, verbose = false): void {
  const icon =
    d.status === 'verified' ? '✓' :
    d.status === 'phantom'  ? '↗' :
    d.status === 'approved' ? '●' :
    d.status === 'synced'   ? '✔' :
    d.status === 'rejected' ? '✗' : '○';

  const confidence =
    d.confidence === 'high'   ? '\x1b[32mhigh\x1b[0m' :
    d.confidence === 'medium' ? '\x1b[33mmedium\x1b[0m' :
                                '\x1b[31mlow\x1b[0m';

  logger.info(`${icon} [${d.id}] ${d.title}`);
  if (verbose) {
    logger.info(`   Status     : ${d.status}  Confidence: ${confidence}`);
    logger.info(`   Rationale  : ${d.rationale}`);
    if (d.affectedDomains.length) logger.info(`   Domains    : ${d.affectedDomains.join(', ')}`);
    if (d.proposedRequirement) logger.info(`   Requirement: ${d.proposedRequirement}`);
    if (d.evidenceFile) logger.info(`   Evidence   : ${d.evidenceFile}`);
  }
}

function displayMissing(missing: Array<{ file: string; description: string }>): void {
  if (missing.length === 0) return;
  logger.section('Unrecorded Changes Detected');
  for (const m of missing) {
    logger.warning(`⚠ ${m.file}: ${m.description}`);
  }
  logger.info('These changes were not recorded as decisions. Consider adding them with record_decision.');
}

// ============================================================================
// COMMAND
// ============================================================================

export const decisionsCommand = new Command('decisions')
  .description('Record, consolidate, and sync architectural decisions to OpenSpec')
  .option('--consolidate', 'Consolidate drafts + verify against diff', false)
  .option('--gate', 'Exit non-zero if decisions await review (for use in hooks)', false)
  .option('--approve <id>', 'Approve a decision by ID')
  .option('--reject <id>', 'Reject a decision by ID')
  .option('--note <text>', 'Note to attach to approve/reject action')
  .option('--sync', 'Sync all approved decisions to spec.md files', false)
  .option('--dry-run', 'Preview sync without writing', false)
  .option('--list', 'List decisions (default action when no other flag given)', false)
  .option('--status <status>', 'Filter list by status (draft|consolidated|verified|approved|rejected|synced)')
  .option('--install-hook', 'Install pre-commit hook', false)
  .option('--uninstall-hook', 'Remove pre-commit hook', false)
  .option('--verbose', 'Show detailed decision info', false)
  .option('--json', 'Output as JSON', false)
  .addHelpText(
    'after',
    `
Workflow:
  1. During dev: agent calls record_decision MCP tool
  2. At commit: spec-gen decisions --consolidate  (or via hook)
  3. Review: spec-gen decisions --approve <id>
  4. Write to spec: spec-gen decisions --sync

Examples:
  $ spec-gen decisions                             List pending decisions
  $ spec-gen decisions --consolidate               Consolidate + verify drafts
  $ spec-gen decisions --approve a1b2c3d4          Approve decision a1b2c3d4
  $ spec-gen decisions --sync                      Sync approved decisions
  $ spec-gen decisions --install-hook              Install pre-commit gate
  $ spec-gen decisions --status verified --json    Machine-readable output
`
  )
  .action(async function (this: Command, options: {
    consolidate: boolean;
    gate: boolean;
    approve?: string;
    reject?: string;
    note?: string;
    sync: boolean;
    dryRun: boolean;
    list: boolean;
    status?: string;
    installHook: boolean;
    uninstallHook: boolean;
    verbose: boolean;
    json: boolean;
  }) {
    const globalOpts = this.parent?.opts() ?? {};
    const rootPath = process.cwd();

    // ── Hook management ──────────────────────────────────────────────────────
    if (options.installHook) {
      await installPreCommitHook(rootPath);
      return;
    }
    if (options.uninstallHook) {
      await uninstallPreCommitHook(rootPath);
      return;
    }

    // ── Load store (always needed) ───────────────────────────────────────────
    const store = await loadDecisionStore(rootPath);

    // ── Approve ──────────────────────────────────────────────────────────────
    if (options.approve) {
      const id = options.approve;
      const decision = store.decisions.find((d) => d.id === id);
      if (!decision) {
        logger.error(`Decision ${id} not found.`);
        process.exitCode = 1;
        return;
      }
      const updated = patchDecision(store, id, {
        status: 'approved',
        reviewedAt: new Date().toISOString(),
        reviewNote: options.note,
      });
      await saveDecisionStore(rootPath, updated);
      logger.success(`Decision ${id} approved.`);
      if (!options.json) displayDecision({ ...decision, status: 'approved' }, true);
      return;
    }

    // ── Reject ───────────────────────────────────────────────────────────────
    if (options.reject) {
      const id = options.reject;
      const decision = store.decisions.find((d) => d.id === id);
      if (!decision) {
        logger.error(`Decision ${id} not found.`);
        process.exitCode = 1;
        return;
      }
      const updated = patchDecision(store, id, {
        status: 'rejected',
        reviewedAt: new Date().toISOString(),
        reviewNote: options.note,
      });
      await saveDecisionStore(rootPath, updated);
      logger.success(`Decision ${id} rejected.`);
      return;
    }

    // ── Consolidate + Verify ─────────────────────────────────────────────────
    if (options.consolidate) {
      const specGenConfig = await readSpecGenConfig(rootPath);
      if (!specGenConfig) {
        logger.error('No spec-gen configuration found. Run "spec-gen init" first.');
        process.exitCode = 1;
        return;
      }

      const drafts = getDecisionsByStatus(store, 'draft');
      if (drafts.length === 0) {
        if (options.gate) process.exitCode = 0;
        else logger.info('No draft decisions to consolidate.');
        return;
      }

      const resolved = resolveLLMProvider(specGenConfig);
      if (!resolved) {
        logger.error('No LLM provider configured. Consolidation requires an LLM.');
        logger.discovery('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or configure llm in .spec-gen/config.json');
        process.exitCode = 1;
        return;
      }

      const llm = createLLMService({
        provider: resolved.provider,
        model: specGenConfig.generation?.model,
        openaiCompatBaseUrl: resolved.openaiCompatBaseUrl,
        apiBase: globalOpts.apiBase ?? specGenConfig.llm?.apiBase,
        sslVerify: globalOpts.insecure != null ? !globalOpts.insecure : (specGenConfig.llm?.sslVerify ?? true),
        enableLogging: true,
        logDir: join(rootPath, SPEC_GEN_DIR, SPEC_GEN_LOGS_SUBDIR),
      });

      if (!options.json) logger.discovery(`Consolidating ${drafts.length} draft decision(s) via ${resolved.provider}...`);

      // Step 1 — Consolidate
      const consolidated = await consolidateDrafts(store, llm);
      if (consolidated.length === 0) {
        if (!options.json) logger.info('No architectural decisions found in drafts.');
        if (options.gate) process.exitCode = 0;
        return;
      }

      // Step 2 — Build diff for verification
      let combinedDiff = '';
      try {
        if (await isGitRepository(rootPath)) {
          const baseRef = await resolveBaseRef(rootPath, 'auto');
          const gitResult = await getChangedFiles({ rootPath, baseRef, includeUnstaged: false });
          const relevant = gitResult.files.slice(0, DECISIONS_EXTRACTION_MAX_FILES);
          const diffs = await Promise.all(
            relevant.map((f) => getFileDiff(rootPath, f.path, baseRef, DECISIONS_DIFF_MAX_CHARS))
          );
          combinedDiff = diffs.join('\n\n');
        }
      } catch { /* diff unavailable — skip verification */ }

      // Step 3 — Verify
      const { verified, phantom, missing } = combinedDiff
        ? await verifyDecisions(consolidated, combinedDiff, llm)
        : { verified: consolidated.map((d) => ({ ...d, status: 'verified' as const, confidence: 'medium' as const })), phantom: [], missing: [] };

      // Step 4 — Persist
      let updatedStore = { ...store };
      // Mark superseded drafts as rejected
      const supersededIds = new Set(consolidated.flatMap((c: any) => c.supersededIds ?? []));
      for (const id of supersededIds) {
        updatedStore = patchDecision(updatedStore, id, { status: 'rejected' });
      }
      updatedStore = upsertDecisions(updatedStore, [...verified, ...phantom]);
      await saveDecisionStore(rootPath, updatedStore);

      if (options.json) {
        process.stdout.write(JSON.stringify({ verified, phantom, missing }, null, 2) + '\n');
        if (options.gate && verified.length > 0) process.exitCode = 1;
        return;
      }

      // Human-facing recap
      logger.section('Architectural Decisions — Review Required');

      if (verified.length > 0) {
        logger.info('\nVerified decisions (found in code):');
        for (const d of verified) displayDecision(d, options.verbose);
      }

      if (phantom.length > 0) {
        logger.info('\nPhantom decisions (recorded but not found in diff):');
        for (const d of phantom) displayDecision(d, options.verbose);
      }

      displayMissing(missing);

      logger.info('\nApprove with: spec-gen decisions --approve <id>');
      logger.info('Reject with:  spec-gen decisions --reject <id>');
      logger.info('Sync all approved: spec-gen decisions --sync');

      if (options.gate && verified.length > 0) {
        logger.warning('\nCommit gated — review decisions above before committing.');
        process.exitCode = 1;
      }
      return;
    }

    // ── Sync ─────────────────────────────────────────────────────────────────
    if (options.sync) {
      const specGenConfig = await readSpecGenConfig(rootPath);
      if (!specGenConfig) {
        logger.error('No spec-gen configuration found.');
        process.exitCode = 1;
        return;
      }

      const openspecPath = join(rootPath, specGenConfig.openspecPath ?? OPENSPEC_DIR);
      const specsPath = join(openspecPath, OPENSPEC_SPECS_SUBDIR);
      if (!(await fileExists(specsPath))) {
        logger.error('No specs found. Run "spec-gen generate" first.');
        process.exitCode = 1;
        return;
      }

      const specMap = await buildSpecMap({ rootPath, openspecPath });
      const approved = getDecisionsByStatus(store, 'approved');

      if (approved.length === 0) {
        logger.info('No approved decisions to sync. Use --approve <id> first.');
        return;
      }

      if (!options.json) logger.discovery(`Syncing ${approved.length} approved decision(s)...`);

      const { result } = await syncApprovedDecisions(store, {
        rootPath,
        openspecPath,
        specMap,
        dryRun: options.dryRun,
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }

      for (const d of result.synced) {
        logger.success(`✔ Synced [${d.id}] ${d.title}`);
        for (const p of d.syncedToSpecs) logger.info(`   → ${p}`);
      }
      for (const e of result.errors) {
        logger.error(`✗ [${e.id}] ${e.error}`);
      }
      if (options.dryRun) logger.info('\n(dry-run — no files were written)');
      return;
    }

    // ── Default: list ────────────────────────────────────────────────────────
    const all = options.status
      ? store.decisions.filter((d) => d.status === options.status)
      : store.decisions;

    if (options.json) {
      process.stdout.write(JSON.stringify(all, null, 2) + '\n');
      return;
    }

    if (all.length === 0) {
      logger.info('No decisions recorded yet. Agents can call the record_decision MCP tool during development.');
      return;
    }

    logger.section('Architectural Decisions');
    for (const d of all) displayDecision(d, options.verbose);
    logger.info(`\nTotal: ${all.length}`);
  });
