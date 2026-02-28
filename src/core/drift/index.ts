/**
 * Drift detection module
 *
 * Detects when code changes diverge from existing OpenSpec specifications.
 */

export { getChangedFiles, getFileDiff, isGitRepository, getCurrentBranch, resolveBaseRef, classifyFile } from './git-diff.js';
export type { GitDiffOptions, GitDiffResult } from './git-diff.js';

export { buildSpecMap, matchFileToDomains, getSpecContent, parseSpecHeader, parseSpecReferences, inferDomainFromPath, buildADRMap, parseADRRelated } from './spec-mapper.js';
export type { SpecMapperOptions, ADRMapping, ADRMap } from './spec-mapper.js';

export { detectDrift, detectGaps, detectStaleSpecs, detectUncoveredFiles, detectOrphanedSpecs, isSpecRelevantChange, computeSeverity, extractChangedSpecDomains, enhanceGapsWithLLM, detectADRGaps, detectADROrphaned, extractChangedADRIds } from './drift-detector.js';
export type { DriftDetectorOptions } from './drift-detector.js';
