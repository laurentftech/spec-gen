/**
 * spec-gen-decision-extractor.ts
 *
 * Plugin OpenCode : extraction proactive des décisions architecturales.
 *
 * Mécanisme :
 *   1. tool.execute.after — détecte les écritures de fichiers source et
 *      enregistre les candidats à analyser (avec sessionID).
 *   2. session.idle — appel HTTP direct au LLM configuré (JSON-only, pas de
 *      tool calling). Parse la réponse et écrit dans pending.json directement.
 *      Cooldown 5 min par session pour éviter les spawns répétés.
 *
 * Env vars :
 *   OPENAI_BASE_URL         — défaut: https://codestral.mistral.ai/v1
 *   OPENAI_API_KEY          — défaut: $MISTRAL_API_KEY
 *   OPENAI_MODEL_EXTRACTOR  — défaut: devstral-small-latest
 *
 * Placer dans : .opencode/plugins/spec-gen-decision-extractor.ts
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import type { Plugin } from '@opencode-ai/plugin';
import {
  scoreFromDepGraph,
  HUB_INDEGREE,
  HIGH_PAGERANK,
  HIGH_FILE_SCORE,
} from './lib/spec-gen-decision-extractor-helpers.js';
import type { FileScore } from './lib/spec-gen-decision-extractor-helpers.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const EXTRACT_BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://codestral.mistral.ai/v1';
const EXTRACT_API_KEY = process.env.OPENAI_API_KEY ?? process.env.MISTRAL_API_KEY ?? '';
const EXTRACT_MODEL = process.env.OPENAI_MODEL_EXTRACTOR ?? 'devstral-small-latest';

const SPEC_GEN_BIN = resolveSpecGen();

function resolveSpecGen(): string {
  for (const c of ['node_modules/.bin/spec-gen', 'dist/cli/index.js']) {
    try {
      execSync(`test -f ${c}`, { stdio: 'pipe' });
      return c.endsWith('.js') ? `node ${c}` : c;
    } catch {}
  }
  return 'spec-gen';
}

// Fichiers source à surveiller
const SOURCE_PATTERN = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|cpp|c|h)$/;
const SKIP_PATTERN =
  /\.(test|spec|stories|mock|fixture)\.[jt]sx?$|\.d\.ts$|\.lock$|\.json$|\.ya?ml$|\.md$|\.env$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseJSON<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

function run(args: string): string {
  try {
    return execSync(`${SPEC_GEN_BIN} ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    return e.stdout ?? '';
  }
}

function getActiveDecisions(): any[] {
  return parseJSON<any[]>(run('decisions --list --json')) ?? [];
}

function getSpecDomains(): string[] {
  try {
    return execSync('ls openspec/specs/', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isSource(filePath: string): boolean {
  return SOURCE_PATTERN.test(filePath) && !SKIP_PATTERN.test(filePath);
}

function alreadyCovered(filePath: string): boolean {
  return getActiveDecisions().some((d) => (d.affectedFiles ?? []).includes(filePath));
}

// Prompt envoyé au Librarian (ou au fallback LLM)
function buildPrompt(filePath: string, content: string, score: FileScore | null): string {
  const domains = getSpecDomains();

  const scoreContext = score
    ? [
        `STRUCTURAL CONTEXT (from static analysis):`,
        `  inDegree  : ${score.inDegree} file(s) import this file`,
        `  pageRank  : ${(score.pageRank * 100).toFixed(0)}% (normalized importance)`,
        `  fileScore : ${(score.fileScore * 100).toFixed(0)}% (significance score)`,
        score.isHub
          ? `  → This is a HUB file. Lean toward recording a decision.`
          : `  → Low centrality. Only record if clearly architectural.`,
      ].join('\n')
    : `STRUCTURAL CONTEXT: File not found in dep-graph (new file — treat as potentially architectural).`;

  return [
    `You are an architectural decision detector for a spec-driven development project.`,
    ``,
    `FILE: ${filePath}`,
    `KNOWN SPEC DOMAINS: ${domains.join(', ') || 'unknown'}`,
    ``,
    scoreContext,
    ``,
    `NEW CONTENT (first 800 chars):`,
    content.slice(0, 800),
    ``,
    `TASK: Determine if this file change represents an architectural decision.`,
    ``,
    `Architectural = any of:`,
    `- Module responsibility change`,
    `- New pattern or abstraction introduced`,
    `- Communication or data flow change`,
    `- New external dependency`,
    `- Error handling strategy change`,
    `- Performance trade-off with downstream consequences`,
    ``,
    `NOT architectural = formatting, renaming, trivial bug fixes, test additions, config values.`,
    ``,
    `If architectural: respond with ONLY this JSON object (no explanation, no markdown):`,
    `{"title":"<max 10 words>","rationale":"<2-3 sentences>","affectedDomains":["<domain>"],"affectedFiles":["${filePath}"],"consequences":"<1-2 sentences>"}`,
    ``,
    `If NOT architectural: respond with ONLY the string: NOT_ARCHITECTURAL`,
    ``,
    `Do not call any tools. Do not explain. Respond with JSON or NOT_ARCHITECTURAL only.`,
  ].join('\n');
}

// ─── Extraction HTTP + écriture pending.json ─────────────────────────────────

function writeToPending(decision: any, sessionId: string, rootDir = process.cwd()): void {
  const dir = join(rootDir, '.spec-gen', 'decisions');
  const file = join(dir, 'pending.json');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const store = existsSync(file)
    ? (parseJSON<any>(readFileSync(file, 'utf-8')) ?? { version: '1', decisions: [] })
    : { version: '1', decisions: [] };

  const id = createHash('sha256')
    .update(`${sessionId}:${decision.title}`)
    .digest('hex')
    .slice(0, 8);

  store.decisions.push({
    id,
    status: 'draft',
    title: decision.title,
    rationale: decision.rationale,
    consequences: decision.consequences ?? '',
    proposedRequirement: null,
    affectedDomains: decision.affectedDomains ?? [],
    affectedFiles: decision.affectedFiles ?? [],
    confidence: 'medium',
    sessionId,
    recordedAt: new Date().toISOString(),
    syncedToSpecs: [],
  });

  store.updatedAt = new Date().toISOString();
  store.sessionId = sessionId;
  writeFileSync(file, JSON.stringify(store, null, 2));
}

async function extractAndRecord(
  filePath: string,
  content: string,
  score: FileScore | null,
  sessionId: string
): Promise<void> {
  if (!EXTRACT_API_KEY) return;

  const prompt = buildPrompt(filePath, content, score);

  try {
    const res = await fetch(`${EXTRACT_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${EXTRACT_API_KEY}`,
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 300,
      }),
    });

    if (!res.ok) return;

    const data = await res.json();
    const text: string = (data?.choices?.[0]?.message?.content ?? '').trim();

    if (text === 'NOT_ARCHITECTURAL' || text.startsWith('NOT_ARCHITECTURAL')) return;

    const decision = parseJSON<any>(text);
    if (!decision?.title) return;

    writeToPending(decision, sessionId);

    await (globalThis as any).__opencode_client?.app?.log?.({
      body: {
        service: 'decision-extractor',
        level: 'info',
        message: `Decision recorded for ${filePath}: "${decision.title}"`,
      },
    });
  } catch {
    // Non-bloquant
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes entre deux spawns Librarian par session

export const SpecGenDecisionExtractor: Plugin = async ({ client }) => {
  // Fichiers en attente d'analyse : filePath → { content, score, sessionID }
  const pending = new Map<
    string,
    { content: string; score: FileScore | null; sessionID: string }
  >();

  // Cooldown par sessionID : timestamp du dernier appel d'extraction
  const lastExtract = new Map<string, number>();

  // Rendre le client accessible dans extractAndRecord pour le logging
  (globalThis as any).__opencode_client = client;

  return {
    // ── Enrichir record_decision avec les domaines connus ────────────────────
    'tool.definition': async (input: any, output: any) => {
      if (input.toolID !== 'record_decision') return;
      const domains = getSpecDomains();
      if (domains.length === 0) return;
      output.description =
        (output.description ?? '') +
        `\n\nKnown spec domains: ${domains.join(', ')}. Use these exact names in affectedDomains.`;
    },

    // ── Collecte des fichiers à analyser ─────────────────────────────────────
    'tool.execute.after': async (input: any, output: any) => {
      const isFileWrite = [
        'write_file',
        'create_file',
        'str_replace_based_edit_tool',
        'edit',
      ].includes(input.tool);
      if (!isFileWrite) return;

      const filePath: string =
        input.args?.filePath ?? input.args?.path ?? input.args?.file_path ?? '';
      if (!filePath || !isSource(filePath) || alreadyCovered(filePath)) return;

      const score = scoreFromDepGraph(filePath);

      if (score !== null && score.inDegree === 0 && score.pageRank < 0.1 && score.fileScore < 0.3) {
        return;
      }

      let content = '';
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {}
      pending.set(filePath, { content, score, sessionID: input.sessionID ?? '' });
    },

    event: async ({ event }: any) => {
      // ── Extraction sur idle : appel HTTP direct, pas de Librarian ────────
      const sid: string = event.properties?.sessionID ?? event.sessionID ?? '';
      if (event.type === 'session.idle') {
        if (pending.size === 0) return;

        const now = Date.now();
        const sinceLastExtract = now - (lastExtract.get(sid) ?? 0);
        if (sinceLastExtract < COOLDOWN_MS) return;

        const toProcess = [...pending.entries()].filter(([, { sessionID }]) => sessionID === sid);

        if (toProcess.length === 0) return;

        lastExtract.set(sid, now);

        for (const [filePath, { content, score, sessionID }] of toProcess) {
          pending.delete(filePath);
          await extractAndRecord(filePath, content, score, sessionID);
        }
        return;
      }

      if (event.type === 'session.deleted') {
        for (const [filePath, { sessionID }] of pending) {
          if (sessionID === sid) pending.delete(filePath);
        }
        lastExtract.delete(sid);
      }
    },
  };
};
