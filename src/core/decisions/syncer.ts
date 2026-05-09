/**
 * Decision syncer
 *
 * Writes approved decisions into OpenSpec spec.md files (append-only)
 * and creates ADR files for architectural decisions.
 * Never rewrites existing content.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import { logger } from '../../utils/logger.js';
import { parseSpecHeader } from '../drift/spec-mapper.js';
import type { PendingDecision, DecisionStore, SpecMap } from '../../types/index.js';
import { patchDecision, saveDecisionStore } from './store.js';

export interface SyncOptions {
  rootPath: string;
  openspecPath: string;
  specMap: SpecMap;
  dryRun?: boolean;
}

export interface SyncResult {
  synced: PendingDecision[];
  errors: Array<{ id: string; error: string }>;
  modifiedSpecs: string[];
}

export async function syncApprovedDecisions(
  store: DecisionStore,
  options: SyncOptions,
): Promise<{ store: DecisionStore; result: SyncResult }> {
  const approved = store.decisions.filter((d) => d.status === 'approved');
  const synced: PendingDecision[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  const modifiedSpecs = new Set<string>();

  let updatedStore = store;

  for (const decision of approved) {
    try {
      const modified = await syncDecision(decision, options);
      for (const p of modified) modifiedSpecs.add(p);
      const now = new Date().toISOString();
      updatedStore = patchDecision(updatedStore, decision.id, {
        status: 'synced',
        syncedAt: now,
        syncedToSpecs: modified,
      });
      synced.push({ ...decision, status: 'synced', syncedAt: now, syncedToSpecs: modified });
    } catch (err) {
      errors.push({ id: decision.id, error: String(err) });
    }
  }

  if (!options.dryRun) {
    await saveDecisionStore(options.rootPath, updatedStore);
  }

  return {
    store: updatedStore,
    result: { synced, errors, modifiedSpecs: [...modifiedSpecs] },
  };
}

async function syncDecision(
  decision: PendingDecision,
  options: SyncOptions,
): Promise<string[]> {
  const modified: string[] = [];

  for (const domain of decision.affectedDomains) {
    const mapping = options.specMap.byDomain.get(domain);
    if (!mapping) {
      logger.warning(`Decision "${decision.title}": domain "${domain}" not found in spec map — skipping sync to spec`);
      continue;
    }

    const specAbsPath = join(options.rootPath, mapping.specPath);
    if (!(await fileExists(specAbsPath))) continue;

    if (!options.dryRun) {
      await appendToSpec(specAbsPath, decision);
      modified.push(mapping.specPath);
    } else {
      modified.push(mapping.specPath);
    }
  }

  if (options.dryRun) {
    const slug = toKebabCase(decision.title);
    modified.push(`openspec/decisions/adr-XXXX-${slug}.md`);
  } else {
    const adrPath = await createADR(decision, options);
    if (adrPath) modified.push(adrPath);
  }

  return modified;
}

async function appendToSpec(specPath: string, decision: PendingDecision): Promise<void> {
  let content = await readFile(specPath, 'utf-8');

  // 1. Update > Source files: header if new files present
  content = addSourceFiles(content, decision.affectedFiles);

  // 2. Append requirement block inside ## Requirements section
  if (decision.proposedRequirement) {
    content = appendRequirement(content, decision);
  }

  // 3. Append to ## Decisions section (create if absent)
  content = appendDecisionSection(content, decision);

  await writeFile(specPath, content, 'utf-8');
}

function addSourceFiles(content: string, newFiles: string[]): string {
  if (newFiles.length === 0) return content;

  const { sourceFiles } = parseSpecHeader(content);
  const existing = new Set(sourceFiles);
  const toAdd = newFiles.filter((f) => !existing.has(f));
  if (toAdd.length === 0) return content;

  // Find the > Source files: line and append to it
  return content.replace(
    /^(>\s*Source files?:\s*.+)$/im,
    `$1, ${toAdd.join(', ')}`,
  );
}

function appendRequirement(content: string, decision: PendingDecision): string {
  const slug = toPascalCase(decision.title);
  const req = decision.proposedRequirement ?? '';
  const reqText = /^the system shall\b/i.test(req.trim()) ? req.trim() : `The system SHALL ${req}`;
  const block = `
### Requirement: ${slug}

${reqText}

> Decision recorded: ${decision.id}
> Date: ${decision.syncedAt ?? new Date().toISOString().slice(0, 10)}
`;

  // Insert before ## Technical Notes or ## Architecture Notes or append before ## Decisions
  const sectionMatch = content.match(
    /^(##\s+(Technical Notes|Architecture Notes|Decisions))/m,
  );
  if (sectionMatch && sectionMatch.index !== undefined) {
    return (
      content.slice(0, sectionMatch.index).trimEnd() +
      '\n' + block.trimStart() + '\n' +
      content.slice(sectionMatch.index)
    );
  }

  return content.trimEnd() + '\n' + block;
}

function appendDecisionSection(content: string, decision: PendingDecision): string {
  const entry = buildDecisionEntry(decision);

  if (content.includes('## Decisions')) {
    return content.trimEnd() + '\n\n' + entry.trimStart();
  }

  return content.trimEnd() + '\n\n## Decisions\n\n' + entry.trimStart();
}

function buildDecisionEntry(decision: PendingDecision): string {
  return `### ${decision.title}

**Status:** Approved
**Date:** ${(decision.syncedAt ?? new Date().toISOString()).slice(0, 10)}
**ID:** ${decision.id}

${decision.rationale}

**Consequences:** ${decision.consequences}
`;
}

async function createADR(
  decision: PendingDecision,
  options: SyncOptions,
): Promise<string | null> {
  const decisionsDir = join(options.openspecPath, 'decisions');
  await mkdir(decisionsDir, { recursive: true });

  // Find next ADR number
  let maxNum = 0;
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(decisionsDir);
    for (const f of files) {
      const m = f.match(/^adr-(\d+)/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
  } catch { /* empty dir */ }

  const num = String(maxNum + 1).padStart(4, '0');
  const slug = toKebabCase(decision.title);
  const filename = `adr-${num}-${slug}.md`;
  const adrPath = join(decisionsDir, filename);

  const domains = decision.affectedDomains.join(', ');
  const content = `# ADR-${num}: ${decision.title}

## Status

accepted

**Domains**: ${domains}

## Context

${decision.rationale}

## Decision

${decision.proposedRequirement ?? decision.title}

## Consequences

${decision.consequences}

> Recorded by spec-gen decisions on ${(decision.syncedAt ?? new Date().toISOString()).slice(0, 10)}
> Decision ID: ${decision.id}
`;

  await writeFile(adrPath, content, 'utf-8');
  return `openspec/decisions/${filename}`;
}

function toPascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 50);
}
