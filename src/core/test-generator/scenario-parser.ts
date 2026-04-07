/**
 * Scenario Parser
 *
 * Reads OpenSpec spec files and extracts ParsedScenario objects.
 * Extends specGenGetSpecRequirements to also parse the full G/W/T structure
 * from each "#### Scenario:" block within requirement sections.
 *
 * Mapping enrichment:
 *   If .spec-gen/analysis/mapping.json exists, each scenario is enriched with
 *   FunctionRef[] for the matching requirement (confidence ≥ heuristic).
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  SPEC_GEN_DIR,
  SPEC_GEN_ANALYSIS_SUBDIR,
  ARTIFACT_MAPPING,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
} from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';
import type { ParsedScenario, FunctionRef } from '../../types/test-generator.js';

// ============================================================================
// TYPES
// ============================================================================

interface MappingEntry {
  requirement: string;
  domain: string;
  specFile: string;
  functions?: Array<{
    name: string;
    file: string;
    line?: number;
    confidence: string;
  }>;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Slugify a string to kebab-case for file names */
export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase();
}

/** Extract bullet text from lines like "- **GIVEN** ..." or "- **given** ..." */
function extractBullets(lines: string[], keyword: string): string[] {
  const upper = keyword.toUpperCase();
  const results: string[] = [];
  for (const line of lines) {
    // Match: - **GIVEN** text  OR  - **given** text  OR  - GIVEN: text
    const m = line.match(
      new RegExp(`^\\s*[-*]\\s*\\*{0,2}${upper}\\*{0,2}:?\\s*(.+)`, 'i')
    );
    if (m) {
      results.push(m[1].trim());
    }
  }
  return results;
}

/** Check if a scenario block has a complete G/W/T */
function isComplete(given: string[], when: string[], then: string[]): boolean {
  return given.length > 0 && when.length > 0 && then.length > 0;
}

// ============================================================================
// MAPPING LOADER
// ============================================================================

async function loadMapping(
  rootPath: string
): Promise<Map<string, FunctionRef[]>> {
  const map = new Map<string, FunctionRef[]>();
  const mappingPath = join(
    rootPath,
    SPEC_GEN_DIR,
    SPEC_GEN_ANALYSIS_SUBDIR,
    ARTIFACT_MAPPING
  );

  if (!(await fileExists(mappingPath))) return map;

  try {
    const raw = JSON.parse(await readFile(mappingPath, 'utf-8'));
    const entries: MappingEntry[] = raw?.mappings ?? [];
    for (const entry of entries) {
      if (!entry.requirement || !Array.isArray(entry.functions)) continue;
      const refs: FunctionRef[] = entry.functions.map((f) => ({
        name: f.name,
        file: f.file,
        line: f.line,
        confidence: (f.confidence as FunctionRef['confidence']) ?? 'heuristic',
      }));
      map.set(entry.requirement.toLowerCase(), refs);
    }
  } catch {
    // Silently ignore malformed mapping
  }
  return map;
}

// ============================================================================
// SPEC FILE WALKER
// ============================================================================

async function findSpecFiles(
  specsDir: string,
  domains?: string[]
): Promise<Array<{ domain: string; path: string }>> {
  const results: Array<{ domain: string; path: string }> = [];

  if (!(await fileExists(specsDir))) return results;

  let entries: string[];
  try {
    entries = await readdir(specsDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Each entry is a domain directory (or overview, architecture, etc.)
    if (domains && domains.length > 0) {
      const domainLower = entry.toLowerCase();
      const filtered = domains.map((d) => d.toLowerCase());
      if (!filtered.includes(domainLower)) continue;
    }

    const specFile = join(specsDir, entry, 'spec.md');
    if (await fileExists(specFile)) {
      results.push({ domain: entry, path: specFile });
    }
  }

  return results;
}

// ============================================================================
// CORE PARSER
// ============================================================================

/**
 * Parse all scenarios from OpenSpec spec files.
 *
 * @param opts.rootPath   Project root (default: process.cwd())
 * @param opts.domains    If set, only parse these domains
 * @param opts.limit      Maximum number of scenarios to return
 */
export async function parseScenarios(opts: {
  rootPath?: string;
  domains?: string[];
  limit?: number;
}): Promise<ParsedScenario[]> {
  const rootPath = opts.rootPath ?? process.cwd();
  const specsDir = join(rootPath, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR);

  const [specFiles, mappingMap] = await Promise.all([
    findSpecFiles(specsDir, opts.domains),
    loadMapping(rootPath),
  ]);

  const scenarios: ParsedScenario[] = [];

  for (const { domain, path: specPath } of specFiles) {
    let content: string;
    try {
      content = await readFile(specPath, 'utf-8');
    } catch {
      continue;
    }

    const specFileRel = specPath.replace(resolve(rootPath) + '/', '');

    // Split into requirement sections (### Requirement: <name>)
    const reqSections = content.split(/^###\s+Requirement:\s*/m);

    for (let ri = 1; ri < reqSections.length; ri++) {
      const reqBlock = reqSections[ri];
      const reqLines = reqBlock.split('\n');
      const requirement = reqLines[0].trim();
      if (!requirement) continue;

      const functions = mappingMap.get(requirement.toLowerCase()) ?? [];

      // Split into scenario sections (#### Scenario: <name>)
      const scenarioSections = reqBlock.split(/^####\s+Scenario:\s*/m);

      for (let si = 1; si < scenarioSections.length; si++) {
        const scenBlock = scenarioSections[si];
        const scenLines = scenBlock.split('\n');
        const scenarioName = scenLines[0].trim();
        if (!scenarioName) continue;

        const bodyLines = scenLines.slice(1);

        const given = extractBullets(bodyLines, 'given');
        const when = extractBullets(bodyLines, 'when');
        const then = extractBullets(bodyLines, 'then');

        if (!isComplete(given, when, then)) {
          // Incomplete G/W/T — skip silently (caller may log)
          continue;
        }

        scenarios.push({
          domain,
          specFile: specFileRel,
          requirement,
          scenarioName,
          given,
          when,
          then,
          mappedFunctions: functions,
        });

        if (opts.limit && scenarios.length >= opts.limit) {
          return scenarios;
        }
      }
    }
  }

  return scenarios;
}
