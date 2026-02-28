/**
 * Drift Detection Engine
 *
 * Compares code changes (from git) against existing specs (from spec-mapper)
 * to detect gaps, stale specs, uncovered files, and orphaned specs.
 */

import { access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type {
  ChangedFile,
  DriftIssue,
  DriftIssueKind,
  DriftResult,
  DriftSeverity,
  SpecMap,
} from '../../types/index.js';
import { matchFileToDomains, getSpecContent } from './spec-mapper.js';
import { getFileDiff } from './git-diff.js';
import type { LLMService } from '../services/llm-service.js';
import logger from '../../utils/logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface DriftDetectorOptions {
  rootPath: string;
  specMap: SpecMap;
  changedFiles: ChangedFile[];
  failOn: DriftSeverity;
  llm?: LLMService;
  domainFilter?: string[];
  /** Relative path to the openspec directory (e.g. "openspec"). Used for spec-change detection. */
  openspecRelPath?: string;
  /** Git base ref for fetching file diffs (needed for LLM enhancement). */
  baseRef?: string;
  /** Maximum number of LLM calls per run (default: 10). */
  maxLlmCalls?: number;
}

// ============================================================================
// FILE RELEVANCE
// ============================================================================

/** High-value filename patterns that indicate spec-relevant source files */
const HIGH_VALUE_PATTERNS = [
  /service/i, /controller/i, /handler/i, /middleware/i,
  /model/i, /schema/i, /entity/i, /repository/i,
  /route/i, /api/i, /auth/i, /database/i,
];

/**
 * Determine if a changed file is relevant for spec drift detection.
 * Filters out test files, generated files, lock files, assets, etc.
 * @param openspecRelPath - relative path to the openspec directory (default: "openspec")
 */
export function isSpecRelevantChange(file: ChangedFile, openspecRelPath: string = 'openspec'): boolean {
  // Always skip tests and generated files
  if (file.isTest || file.isGenerated) return false;

  // Skip openspec directory changes (those are spec updates, not drift)
  const specPrefix = openspecRelPath.replace(/\/$/, '') + '/';
  if (file.path.startsWith(specPrefix) || file.path.startsWith('.spec-gen/')) return false;

  // Skip markdown files: docs, changelogs, readmes, contributing guides, etc.
  // Only source-embedded .md in non-root src directories could be spec-relevant.
  if (file.extension === '.md') {
    const fileName = basename(file.path).toLowerCase();
    const dir = file.path.split('/')[0];
    // Skip docs directories
    if (dir === 'docs' || dir === 'doc') return false;
    // Skip common standalone markdown files
    if (/^(readme|changelog|changes|history|contributing|license|authors|code.of.conduct|security|todo)/i.test(fileName)) {
      return false;
    }
    // Skip root-level markdown (not inside src/)
    if (!file.path.includes('/')) return false;
  }

  // Skip static assets and lock files (already filtered by git-diff, but double-check)
  const skipExtensions = new Set([
    '.lock', '.lockb', '.map', '.min.js', '.min.css',
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
    '.woff', '.woff2', '.ttf',
  ]);
  if (skipExtensions.has(file.extension)) return false;

  // Skip CI/CD configs
  const fileName = basename(file.path);
  if (fileName === '.github' || file.path.startsWith('.github/')) return false;
  if (fileName === '.gitlab-ci.yml' || fileName === 'Dockerfile') return false;

  // Config files: some are relevant (config.ts, settings.ts), some aren't
  if (file.isConfig) {
    // Manifest files with new dependencies can signal new capabilities
    if (fileName === 'package.json') return true;
    // Build configs are not spec-relevant
    if (/tsconfig|eslint|prettier|babel|jest|vitest|webpack|rollup|vite\.config/i.test(fileName)) {
      return false;
    }
    // App config files are relevant
    return true;
  }

  return true;
}

/**
 * Check if a file is a high-value source file (services, controllers, models, etc.)
 */
function isHighValueFile(filePath: string): boolean {
  const fileName = basename(filePath);
  return HIGH_VALUE_PATTERNS.some(p => p.test(fileName));
}

/**
 * Compute severity based on issue kind and change magnitude
 */
export function computeSeverity(kind: DriftIssueKind, file: ChangedFile): DriftSeverity {
  const totalChanges = file.additions + file.deletions;

  switch (kind) {
    case 'gap':
      if (totalChanges > 30 && isHighValueFile(file.path)) return 'error';
      if (totalChanges > 5) return 'warning';
      return 'info';
    case 'stale':
      if (file.status === 'deleted') return 'error';
      return 'warning';
    case 'uncovered':
      if (isHighValueFile(file.path)) return 'warning';
      return 'info';
    case 'orphaned-spec':
      return 'warning';
    default:
      return 'info';
  }
}

// ============================================================================
// DETECTION ALGORITHMS
// ============================================================================

/**
 * Extract domain names whose specs were also changed in this changeset.
 * Must be called on the FULL changedFiles list (before isSpecRelevantChange
 * filtering), because spec files live under openspec/ which isSpecRelevantChange
 * intentionally excludes from source-drift analysis.
 *
 * @param openspecRelPath - relative path prefix for spec files (default: "openspec")
 */
export function extractChangedSpecDomains(changedFiles: ChangedFile[], openspecRelPath: string = 'openspec'): Set<string> {
  const domains = new Set<string>();
  // Normalize: strip trailing slash, escape for regex
  const prefix = openspecRelPath.replace(/\/$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${prefix}/specs/([^/]+)/`);
  for (const file of changedFiles) {
    const specMatch = file.path.match(pattern);
    if (specMatch) {
      domains.add(specMatch[1]);
    }
  }
  return domains;
}

/**
 * Detect gaps: code changed in a domain but spec wasn't updated.
 * Pass pre-computed changedSpecDomains to avoid depending on openspec/ files
 * being present in changedFiles (they are excluded by isSpecRelevantChange).
 */
export function detectGaps(changedFiles: ChangedFile[], specMap: SpecMap, changedSpecDomains?: Set<string>, openspecRelPath?: string): DriftIssue[] {
  const issues: DriftIssue[] = [];

  // Use pre-computed set if available, otherwise extract from full list
  const updatedSpecDomains = changedSpecDomains ?? extractChangedSpecDomains(changedFiles);

  for (const file of changedFiles) {
    if (!isSpecRelevantChange(file, openspecRelPath)) continue;
    if (file.status === 'deleted') continue; // Deletions handled by detectStaleSpecs

    const domains = matchFileToDomains(file.path, specMap);
    if (domains.length === 0) continue; // No spec coverage — handled by detectUncoveredFiles

    for (const domain of domains) {
      // If the spec was also updated, no gap
      if (updatedSpecDomains.has(domain)) continue;

      const mapping = specMap.byDomain.get(domain);
      const severity = computeSeverity('gap', file);

      issues.push({
        id: `gap:${file.path}:${domain}`,
        kind: 'gap',
        severity,
        message: `File \`${file.path}\` changed (+${file.additions}/-${file.deletions} lines) but spec \`${mapping?.specPath ?? domain}\` was not updated`,
        filePath: file.path,
        domain,
        specPath: mapping?.specPath ?? null,
        changedLines: { added: file.additions, removed: file.deletions },
        suggestion: `Review the ${domain} spec to ensure it still accurately describes the behavior in ${file.path}`,
      });
    }
  }

  return issues;
}

/**
 * Detect stale specs: spec references files that were deleted or heavily modified
 */
export function detectStaleSpecs(changedFiles: ChangedFile[], specMap: SpecMap): DriftIssue[] {
  const issues: DriftIssue[] = [];

  // Build a lookup of changed files by path
  const changedByPath = new Map<string, ChangedFile>();
  for (const file of changedFiles) {
    changedByPath.set(file.path, file);
    if (file.oldPath) {
      changedByPath.set(file.oldPath, file);
    }
  }

  for (const [domain, mapping] of specMap.byDomain) {
    for (const sourceFile of mapping.declaredSourceFiles) {
      const changed = changedByPath.get(sourceFile);
      if (!changed) continue;

      if (changed.status === 'deleted') {
        issues.push({
          id: `stale:${sourceFile}:${domain}`,
          kind: 'stale',
          severity: 'error',
          message: `Spec \`${mapping.specPath}\` references deleted file \`${sourceFile}\``,
          filePath: sourceFile,
          domain,
          specPath: mapping.specPath,
          suggestion: `Update the ${domain} spec to remove references to ${sourceFile}`,
        });
      } else if (changed.status === 'renamed') {
        issues.push({
          id: `stale:${sourceFile}:${domain}`,
          kind: 'stale',
          severity: 'warning',
          message: `Spec \`${mapping.specPath}\` references \`${sourceFile}\` which was renamed to \`${changed.path}\``,
          filePath: sourceFile,
          domain,
          specPath: mapping.specPath,
          suggestion: `Update the ${domain} spec to reference the new path \`${changed.path}\``,
        });
      }
    }
  }

  return issues;
}

/**
 * Detect uncovered files: new files that don't map to any spec domain
 */
export function detectUncoveredFiles(changedFiles: ChangedFile[], specMap: SpecMap, openspecRelPath?: string): DriftIssue[] {
  const issues: DriftIssue[] = [];

  for (const file of changedFiles) {
    if (!isSpecRelevantChange(file, openspecRelPath)) continue;
    if (file.status !== 'added') continue;

    const domains = matchFileToDomains(file.path, specMap);
    if (domains.length > 0) continue; // Already covered by a domain

    const severity = computeSeverity('uncovered', file);

    issues.push({
      id: `uncovered:${file.path}`,
      kind: 'uncovered',
      severity,
      message: `New file \`${file.path}\` has no matching spec domain`,
      filePath: file.path,
      domain: null,
      specPath: null,
      changedLines: { added: file.additions, removed: 0 },
      suggestion: `Consider adding \`${file.path}\` to an existing spec domain or creating a new spec`,
    });
  }

  return issues;
}

/** Meta-domains that describe architecture/overview rather than owning source files */
const META_DOMAINS = new Set(['overview', 'architecture']);

/**
 * Detect orphaned specs: spec declares source files that don't exist on disk.
 * Skips meta-domains (overview, architecture) which often have generic paths.
 */
export async function detectOrphanedSpecs(specMap: SpecMap, rootPath: string): Promise<DriftIssue[]> {
  const issues: DriftIssue[] = [];

  for (const [domain, mapping] of specMap.byDomain) {
    // Skip meta-domains — their "source files" are structural, not ownable
    if (META_DOMAINS.has(domain)) continue;

    for (const sourceFile of mapping.declaredSourceFiles) {
      const fullPath = join(rootPath, sourceFile);
      try {
        await access(fullPath);
      } catch {
        issues.push({
          id: `orphaned-spec:${sourceFile}:${domain}`,
          kind: 'orphaned-spec',
          severity: 'warning',
          message: `Spec \`${mapping.specPath}\` declares source file \`${sourceFile}\` which does not exist`,
          filePath: sourceFile,
          domain,
          specPath: mapping.specPath,
          suggestion: `Update the ${domain} spec to remove the reference to \`${sourceFile}\`, or restore the file`,
        });
      }
    }
  }

  return issues;
}

// ============================================================================
// SEVERITY COMPARISON
// ============================================================================

const SEVERITY_RANK: Record<DriftSeverity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

/**
 * Check if an issue meets or exceeds the given severity threshold
 */
function meetsThreshold(issue: DriftIssue, threshold: DriftSeverity): boolean {
  return SEVERITY_RANK[issue.severity] >= SEVERITY_RANK[threshold];
}

// ============================================================================
// LLM ENHANCEMENT
// ============================================================================

const LLM_SYSTEM_PROMPT = `You are a spec drift analyzer. Given a code diff and a specification, determine if the code change affects behavior described in the spec.

Respond with JSON only: { "relevant": boolean, "confidence": "high" | "medium" | "low", "reason": "one sentence explanation" }

- relevant=true: The change modifies, adds, or removes behavior covered by the spec
- relevant=false: The change is internal (refactoring, formatting, comments, test-only, perf optimization) and doesn't affect spec-described behavior

Be conservative: if unsure, mark as relevant.`;

interface LLMClassification {
  relevant: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/**
 * Post-process gap issues using an LLM to determine if code changes
 * actually affect spec-documented behavior. This reduces false positives
 * by dismissing purely internal changes (refactoring, formatting, etc.).
 *
 * Only processes 'gap' issues. Other issue types (stale, uncovered, orphaned)
 * are structural and don't benefit from semantic analysis.
 */
export async function enhanceGapsWithLLM(
  issues: DriftIssue[],
  options: {
    llm: LLMService;
    rootPath: string;
    specMap: SpecMap;
    baseRef: string;
    maxLlmCalls?: number;
    /** Override diff fetching (for testing) */
    _getDiff?: (rootPath: string, filePath: string, baseRef: string) => Promise<string>;
    /** Override spec content fetching (for testing) */
    _getSpec?: (domain: string, specMap: SpecMap, rootPath: string) => Promise<string | null>;
  },
): Promise<DriftIssue[]> {
  const { llm, rootPath, specMap, baseRef, maxLlmCalls = 10 } = options;
  const getDiff = options._getDiff ?? getFileDiff;
  const getSpec = options._getSpec ?? getSpecContent;

  // Separate gap issues from non-gap issues
  const gapIssues = issues.filter(i => i.kind === 'gap');
  const nonGapIssues = issues.filter(i => i.kind !== 'gap');

  if (gapIssues.length === 0) {
    return issues;
  }

  // Prioritize: errors first, then warnings, then info
  const sortedGaps = [...gapIssues].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );

  // Cap at maxLlmCalls
  const toProcess = sortedGaps.slice(0, maxLlmCalls);
  const skipped = sortedGaps.slice(maxLlmCalls);

  const enhancedGaps: DriftIssue[] = [];

  for (const issue of toProcess) {
    try {
      // Get the code diff for this file
      const diff = await getDiff(rootPath, issue.filePath, baseRef);
      if (!diff) {
        enhancedGaps.push(issue);
        continue;
      }

      // Get the spec content for this domain
      const specContent = issue.domain
        ? await getSpec(issue.domain, specMap, rootPath)
        : null;
      if (!specContent) {
        enhancedGaps.push(issue);
        continue;
      }

      // Ask the LLM
      const userPrompt = `## Code Diff\n\`\`\`diff\n${diff}\n\`\`\`\n\n## Specification (${issue.domain})\n${specContent}`;

      const response = await llm.complete({
        systemPrompt: LLM_SYSTEM_PROMPT,
        userPrompt,
        temperature: 0.1,
        maxTokens: 200,
        responseFormat: 'json',
      });

      // Parse LLM response
      const classification = parseLLMClassification(response.content);

      if (classification) {
        if (!classification.relevant && classification.confidence === 'high') {
          // Downgrade to info — change is not spec-relevant
          enhancedGaps.push({
            ...issue,
            severity: 'info',
            suggestion: `[LLM] Not spec-relevant: ${classification.reason}`,
          });
        } else if (classification.relevant) {
          // Keep severity, enrich suggestion with LLM reasoning
          enhancedGaps.push({
            ...issue,
            suggestion: `${issue.suggestion} [LLM: ${classification.reason}]`,
          });
        } else {
          // Low/medium confidence non-relevant — keep as-is but annotate
          enhancedGaps.push({
            ...issue,
            suggestion: `${issue.suggestion} [LLM (${classification.confidence} confidence): possibly not spec-relevant — ${classification.reason}]`,
          });
        }
      } else {
        // Could not parse LLM response — keep issue unchanged
        enhancedGaps.push(issue);
      }
    } catch (error) {
      logger.debug(`LLM enhancement failed for ${issue.filePath}: ${(error as Error).message}`);
      enhancedGaps.push(issue);
    }
  }

  // Recombine: non-gap issues + enhanced gaps + skipped gaps (unchanged)
  return [...nonGapIssues, ...enhancedGaps, ...skipped];
}

/**
 * Parse the LLM's JSON response into a classification object.
 * Handles markdown code blocks, extra whitespace, etc.
 */
function parseLLMClassification(content: string): LLMClassification | null {
  try {
    // Strip markdown code blocks if present
    let jsonStr = content.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr);

    // Validate expected shape
    if (typeof parsed.relevant !== 'boolean') return null;
    if (!['high', 'medium', 'low'].includes(parsed.confidence)) {
      parsed.confidence = 'medium'; // Default if invalid
    }
    if (typeof parsed.reason !== 'string') {
      parsed.reason = 'No reason provided';
    }

    return {
      relevant: parsed.relevant,
      confidence: parsed.confidence,
      reason: parsed.reason,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// MAIN DETECTION
// ============================================================================

/**
 * Run all drift detection algorithms and produce a combined result
 */
export async function detectDrift(options: DriftDetectorOptions): Promise<DriftResult> {
  const startTime = Date.now();
  const { specMap, changedFiles, failOn, rootPath, domainFilter, openspecRelPath } = options;

  // Pre-compute which spec domains were also updated in this changeset.
  // This must happen before any filtering, since openspec/ files are excluded
  // by isSpecRelevantChange but needed for gap detection.
  const changedSpecDomains = extractChangedSpecDomains(changedFiles, openspecRelPath);

  // Run all detection algorithms
  const gaps = detectGaps(changedFiles, specMap, changedSpecDomains, openspecRelPath);
  const stale = detectStaleSpecs(changedFiles, specMap);
  const uncovered = detectUncoveredFiles(changedFiles, specMap, openspecRelPath);
  const orphaned = await detectOrphanedSpecs(specMap, rootPath);

  // Combine all issues
  let allIssues = [...gaps, ...stale, ...uncovered, ...orphaned];

  // Apply domain filter if provided — exclude null-domain issues too,
  // since the user only wants results for the specified domains
  if (domainFilter && domainFilter.length > 0) {
    allIssues = allIssues.filter(
      issue => issue.domain !== null && domainFilter.includes(issue.domain)
    );
  }

  // Deduplicate by id
  const seen = new Set<string>();
  let dedupedIssues: DriftIssue[] = [];
  for (const issue of allIssues) {
    if (!seen.has(issue.id)) {
      seen.add(issue.id);
      dedupedIssues.push(issue);
    }
  }

  // LLM enhancement: post-process gap issues to reduce false positives
  if (options.llm && options.baseRef) {
    dedupedIssues = await enhanceGapsWithLLM(dedupedIssues, {
      llm: options.llm,
      rootPath,
      specMap,
      baseRef: options.baseRef,
      maxLlmCalls: options.maxLlmCalls,
    });
  }

  // Sort by severity (error > warning > info), then domain, then file path
  dedupedIssues.sort((a, b) => {
    const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDiff !== 0) return severityDiff;
    const domainDiff = (a.domain ?? '').localeCompare(b.domain ?? '');
    if (domainDiff !== 0) return domainDiff;
    return a.filePath.localeCompare(b.filePath);
  });

  // Count spec-relevant changed files
  const specRelevantFiles = changedFiles.filter(f => isSpecRelevantChange(f, openspecRelPath)).length;

  // Determine if drift was detected based on failOn threshold
  const hasDrift = dedupedIssues.some(issue => meetsThreshold(issue, failOn));

  const duration = Date.now() - startTime;

  return {
    timestamp: new Date().toISOString(),
    baseRef: '', // Will be filled by the caller
    totalChangedFiles: changedFiles.length,
    specRelevantFiles,
    issues: dedupedIssues,
    summary: {
      gaps: dedupedIssues.filter(i => i.kind === 'gap').length,
      stale: dedupedIssues.filter(i => i.kind === 'stale').length,
      uncovered: dedupedIssues.filter(i => i.kind === 'uncovered').length,
      orphanedSpecs: dedupedIssues.filter(i => i.kind === 'orphaned-spec').length,
      total: dedupedIssues.length,
    },
    hasDrift,
    duration,
    mode: options.llm ? 'llm-enhanced' : 'static',
  };
}
