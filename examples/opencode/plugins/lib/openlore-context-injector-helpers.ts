/**
 * openlore-context-injector-helpers.ts
 *
 * Pure helper functions extracted from openlore-context-injector.ts so they
 * can be exported for testing without exposing them as OpenCode Plugin symbols.
 *
 * OpenCode loads every export from a plugin file and tries to call it as a
 * Plugin — exporting plain helpers directly from the plugin file causes a
 * crash when OpenCode calls fileToSpecDomain(pluginContext) and reaches
 * `for (const domain of domains)` with domains = undefined.
 * This companion file is the safe export surface for unit tests.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// ─── Config ──────────────────────────────────────────────────────────────────

/** Taille max d'une spec injectée en compaction (pour éviter le bloat). */
export const MAX_SPEC_CHARS = 3000;

/** Nb max de specs complètes injectées en compaction. */
export const MAX_FULL_SPECS = 4;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SpecDomain {
  name: string;
  path: string; // chemin absolu vers spec.md
  purpose: string; // première ligne du ## Purpose
}

// ─── loadSpecDomains ─────────────────────────────────────────────────────────

/** Lit l'index des domaines OpenSpec depuis openspec/specs/. */
export function loadSpecDomains(rootDir = process.cwd()): SpecDomain[] {
  const specsDir = join(rootDir, 'openspec', 'specs');
  try {
    const dirs = readdirSync(specsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    return dirs.flatMap((name) => {
      const specPath = join(specsDir, name, 'spec.md');
      try {
        const content = readFileSync(specPath, 'utf-8');
        const purposeMatch = content.match(/^## Purpose\s*\n+(.+)/m);
        const purpose = purposeMatch
          ? purposeMatch[1].replace(/\[PARTIAL SPEC[^\]]*\]\s*/g, '').trim()
          : '';
        return [{ name, path: specPath, purpose }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

// ─── readSpec ────────────────────────────────────────────────────────────────

/** Lit le contenu d'une spec, tronqué à maxChars. */
export function readSpec(domain: SpecDomain, maxChars = MAX_SPEC_CHARS): string {
  try {
    const content = readFileSync(domain.path, 'utf-8');
    if (content.length <= maxChars) return content;
    const truncated = content.slice(0, maxChars);
    const lastSection = truncated.lastIndexOf('\n##');
    return (
      (lastSection > 0 ? truncated.slice(0, lastSection) : truncated) +
      `\n\n… (spec truncated — use get_spec ${domain.name} for full content)`
    );
  } catch {
    return '';
  }
}

// ─── fileToSpecDomain ────────────────────────────────────────────────────────

/**
 * Mappe un chemin de fichier source vers un domaine OpenSpec probable.
 * Utilise le mapping.json si disponible, sinon heuristique par répertoire.
 */
export function fileToSpecDomain(
  filePath: string,
  domains: SpecDomain[],
  rootDir = process.cwd()
): string | null {
  try {
    const raw = readFileSync(join(rootDir, '.openlore', 'analysis', 'mapping.json'), 'utf-8');
    const mapping = JSON.parse(raw);
    const entries: any[] = Array.isArray(mapping) ? mapping : Object.values(mapping);
    const match = entries.find(
      (e: any) =>
        e.file === filePath ||
        e.filePath === filePath ||
        (Array.isArray(e.files) && e.files.includes(filePath))
    );
    if (match?.domain || match?.spec) return match.domain ?? match.spec;
  } catch {
    /* mapping non disponible */
  }

  for (const domain of domains) {
    if (filePath.toLowerCase().includes(domain.name.toLowerCase())) return domain.name;
  }

  const parts = filePath.split('/');
  for (const part of parts) {
    const match = domains.find((d) => d.name === part);
    if (match) return match.name;
  }

  return null;
}
