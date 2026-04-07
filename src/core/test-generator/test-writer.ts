/**
 * Test Writer
 *
 * Writes GeneratedTestFile objects to disk.
 * Respects --dry-run (preview only) and --merge (append new scenarios).
 *
 * Merge logic:
 *   When --merge is set, the writer reads the existing file and checks which
 *   scenario metadata tags are already present. New scenarios are appended;
 *   existing ones are skipped (no duplicate detection by content hash).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import type { GeneratedTestFile } from '../../types/test-generator.js';

// ============================================================================
// TYPES
// ============================================================================

export interface WriteResult {
  written: number;
  skipped: number;
  merged: number;
  dryRunPreview?: string[];
}

// ============================================================================
// MERGE HELPERS
// ============================================================================

/** Extract scenario keys already present in a file via spec-gen: tags */
function extractExistingScenarioKeys(content: string): Set<string> {
  const keys = new Set<string>();
  const tagRegex = /(?:\/\/|#)\s*spec-gen:\s*(\{[^\n]+\})/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(content)) !== null) {
    try {
      const tag = JSON.parse(m[1]);
      if (tag.domain && tag.requirement && tag.scenario) {
        keys.add(`${tag.domain}::${tag.requirement}::${tag.scenario}`);
      }
    } catch {
      // malformed tag, ignore
    }
  }
  return keys;
}

/**
 * Extract the "blocks" (one per scenario) from generated content.
 * Each block starts with a spec-gen: tag comment line.
 */
function splitIntoBlocks(content: string): string[] {
  // Split on spec-gen: tag lines, keeping the delimiter
  const parts = content.split(/(?=(?:\/\/|#)\s*spec-gen:\s*\{)/);
  // First part is the import header (before any tags)
  return parts;
}

function buildMergedContent(
  existing: string,
  newContent: string,
  existingKeys: Set<string>
): { content: string; added: number } {
  const blocks = splitIntoBlocks(newContent);
  const header = blocks[0]; // imports etc.
  const scenarioBlocks = blocks.slice(1);

  let added = 0;
  const newBlocks: string[] = [];

  for (const block of scenarioBlocks) {
    const tagMatch = block.match(/(?:\/\/|#)\s*spec-gen:\s*(\{[^\n]+\})/);
    if (!tagMatch) continue;
    try {
      const tag = JSON.parse(tagMatch[1]);
      const key = `${tag.domain}::${tag.requirement}::${tag.scenario}`;
      if (!existingKeys.has(key)) {
        newBlocks.push(block);
        added++;
      }
    } catch {
      newBlocks.push(block); // keep unparseable blocks
      added++;
    }
  }

  if (newBlocks.length === 0) return { content: existing, added: 0 };

  const merged = existing.trimEnd() + '\n\n' + newBlocks.join('\n').trimStart();
  return { content: merged, added };
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function writeTestFiles(opts: {
  files: GeneratedTestFile[];
  rootPath: string;
  dryRun: boolean;
  merge: boolean;
}): Promise<WriteResult> {
  const { files, rootPath, dryRun, merge } = opts;
  const result: WriteResult = { written: 0, skipped: 0, merged: 0 };

  if (dryRun) {
    result.dryRunPreview = [];
  }

  for (const file of files) {
    const absPath = resolve(rootPath, file.outputPath);
    const exists = await fileExists(absPath);

    if (dryRun) {
      result.dryRunPreview!.push(
        `  ${exists ? (merge ? '[merge]' : '[skip]') : '[new]'} ${file.outputPath} (${file.scenarios.length} scenario${file.scenarios.length > 1 ? 's' : ''})`
      );

      // Show assertion preview for the first scenario
      const firstScenario = file.scenarios[0];
      if (firstScenario) {
        const preview = file.content
          .split('\n')
          .filter((l) => l.trim() && !l.startsWith('import') && !l.includes('spec-gen:'))
          .slice(0, 8)
          .map((l) => `      ${l}`)
          .join('\n');
        if (preview) result.dryRunPreview!.push(preview);
      }
      continue;
    }

    if (exists && !merge) {
      file.isNew = false;
      result.skipped++;
      continue;
    }

    if (exists && merge) {
      const existing = await readFile(absPath, 'utf-8');
      const existingKeys = extractExistingScenarioKeys(existing);
      const { content, added } = buildMergedContent(existing, file.content, existingKeys);

      if (added === 0) {
        file.isNew = false;
        result.skipped++;
        continue;
      }

      await writeFile(absPath, content, 'utf-8');
      file.isNew = false;
      result.merged++;
      continue;
    }

    // New file
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, file.content, 'utf-8');
    file.isNew = true;
    result.written++;
  }

  return result;
}
