/**
 * openlore-context-injector.ts
 *
 * Plugin OpenCode : injection des spécifications OpenSpec dans le contexte
 * Sisyphus pour fermer le triangle SDD (Specs ↔ Tests ↔ Code).
 *
 * Problème résolu :
 *   Les plugins enforcer et decision-extractor agissent APRÈS le code.
 *   Sisyphus ne lit pas les specs AVANT de coder, ce qui crée un risque de
 *   dérive silencieuse. Ce plugin injecte la vérité architecturale du projet
 *   dans chaque tour de conversation.
 *
 * Mécanisme :
 *   1. experimental.chat.system.transform — injecte à chaque tour un index
 *      compact des domaines OpenSpec disponibles (quelques lignes, faible coût).
 *   2. tool.execute.after — détecte les fichiers écrits et mappe leur domaine
 *      OpenSpec pour savoir quels specs sont "actifs" dans la session.
 *   3. experimental.session.compacting — injecte le contenu complet des specs
 *      actives lors des compactions pour préserver la connaissance des contrats.
 *
 * Placer dans : .opencode/plugins/openlore-context-injector.ts
 */

import type { Plugin } from '@opencode-ai/plugin';
import {
  loadSpecDomains,
  readSpec,
  fileToSpecDomain,
  MAX_FULL_SPECS,
} from './lib/openlore-context-injector-helpers.ts';
import type { SpecDomain } from './lib/openlore-context-injector-helpers.ts';

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const OpenLoreContextInjector: Plugin = async (_ctx: any) => {
  // Domaines actifs dans la session courante (fichiers écrits par l'agent)
  // Map sessionID → Set<domainName>
  const activeDomains = new Map<string, Set<string>>();

  // Cache de l'index des domaines (rechargé si les specs changent)
  let domainsCache: SpecDomain[] | null = null;
  let domainsCacheTime = 0;
  const CACHE_TTL_MS = 30_000;

  function getDomains(): SpecDomain[] {
    const now = Date.now();
    if (!domainsCache || now - domainsCacheTime > CACHE_TTL_MS) {
      domainsCache = loadSpecDomains();
      domainsCacheTime = now;
    }
    return domainsCache;
  }

  return {
    // ── 1. Index compact injecté à chaque tour ────────────────────────────────
    //
    // input: { sessionID?, model }
    // output: { system: string[] } — mutable (push des lignes)
    //
    // On injecte un tableau compact des domaines disponibles : quelques lignes
    // suffisent pour que Sisyphus sache quoi chercher avec get_spec/search_specs.
    //
    'experimental.chat.system.transform': async (_input: any, output: any) => {
      const domains = getDomains();
      if (domains.length === 0) return;

      const index = [
        '## OpenSpec Contracts — read before modifying any module',
        '',
        'This project has structured specifications. Check the relevant spec BEFORE changing a module.',
        '',
        '| Domain | Purpose |',
        '|--------|---------|',
        ...domains.map(
          (d) => `| \`${d.name}\` | ${d.purpose.slice(0, 80)}${d.purpose.length > 80 ? '…' : ''} |`
        ),
        '',
        'Tools: `get_spec <domain>` · `search_specs <query>` · `check_spec_drift` after changes',
      ].join('\n');

      output.system.push(index);
    },

    // ── 2. Tracking des domaines actifs dans la session ───────────────────────
    //
    // input: { tool, sessionID, callID, args }
    // output: { title, output, metadata }
    //
    'tool.execute.after': async (input: any) => {
      const isFileWrite = [
        'write_file',
        'create_file',
        'str_replace_based_edit_tool',
        'edit',
      ].includes(input.tool);
      if (!isFileWrite || !input.sessionID) return;

      const filePath: string = input.args?.path ?? input.args?.file_path ?? '';
      if (!filePath) return;

      const domains = getDomains();
      const domain = fileToSpecDomain(filePath, domains);
      if (!domain) return;

      if (!activeDomains.has(input.sessionID)) {
        activeDomains.set(input.sessionID, new Set());
      }
      activeDomains.get(input.sessionID)!.add(domain);
    },

    // ── 3. Injection complète des specs actives lors des compactions ──────────
    //
    // input: { sessionID }
    // output: { context: string[], prompt?: string } — mutable
    //
    // Contrairement au system.transform (index compact), ici on injecte le
    // contenu complet des specs des domaines touchés dans la session.
    // Ça préserve les contrats architecturaux après compression du contexte.
    //
    'experimental.session.compacting': async (input: any, output: any) => {
      const domains = getDomains();
      if (domains.length === 0) return;

      const sessionActive = activeDomains.get(input.sessionID) ?? new Set<string>();

      // Specs à injecter : d'abord les domaines actifs, puis overview en fallback
      const toInject: SpecDomain[] = [];

      for (const name of sessionActive) {
        const d = domains.find((x) => x.name === name);
        if (d) toInject.push(d);
        if (toInject.length >= MAX_FULL_SPECS) break;
      }

      // Toujours inclure overview si pas déjà là
      const overview = domains.find((d) => d.name === 'overview');
      if (overview && !toInject.find((d) => d.name === 'overview')) {
        toInject.unshift(overview);
      }

      if (toInject.length === 0) return;

      output.context.push(
        '## Active OpenSpec Contracts — enforce these before coding',
        '',
        `Domains active in this session: ${[...sessionActive].join(', ') || '(none yet)'}`,
        '',
        ...toInject.flatMap((domain) => {
          const content = readSpec(domain);
          if (!content) return [];
          return [`### Spec: ${domain.name}`, '', content, ''];
        }),
        '⚠️  Code changes MUST satisfy the SHALL/MUST requirements above.',
        'Run `check_spec_drift` after changes to verify alignment.'
      );
    },

    // ── Nettoyage session ─────────────────────────────────────────────────────
    event: async ({ event }: any) => {
      if (event.type === 'session.deleted') {
        activeDomains.delete(event.sessionID);
      }
    },
  };
};
