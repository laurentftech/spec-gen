/**
 * spec-gen-enforcer.ts  v2
 *
 * Plugin OpenCode : enforce le workflow SDD spec-gen.
 *
 * Blocs :
 *   1. tool.execute.before  — nudge avant toute écriture de fichier source sans
 *      décision enregistrée ; avertissement sur approve/reject_decision (déjà
 *      protégés côté MCP par requiresHumanAuthorization).
 *   2. session.idle event   — gate check : vérifie l'état des décisions et
 *      présente les décisions en attente à l'agent.
 *   3. tool.execute.after   — rappel périodique toutes les 5 actions.
 *   4. experimental.session.compacting — préserve les décisions actives lors
 *      des compactions de contexte pour éviter la dérive silencieuse.
 *
 * Placer dans : .opencode/plugins/spec-gen-enforcer.ts
 */

import { execSync } from 'child_process';
import type { Plugin } from '@opencode-ai/plugin';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GateResult {
  gated: boolean;
  reason?: string;
  verified?: any[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

let _specGenBin: string | null = null;

function resolveSpecGen(): string {
  if (_specGenBin) return _specGenBin;
  for (const c of ['node_modules/.bin/spec-gen', 'dist/cli/index.js']) {
    try {
      execSync(`test -f ${c}`, { stdio: 'pipe' });
      _specGenBin = c.endsWith('.js') ? `node ${c}` : c;
      return _specGenBin;
    } catch {}
  }
  _specGenBin = 'spec-gen';
  return _specGenBin;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(args: string): string {
  try {
    return execSync(`${resolveSpecGen()} ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    return e.stdout ?? '';
  }
}

function parseJSON<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

function runGate(): GateResult | null {
  return parseJSON<GateResult>(run('decisions --gate --json'));
}

function getActiveDecisions(): any[] {
  return parseJSON<any[]>(run('decisions --list --json')) ?? [];
}

// Fichiers source susceptibles de contenir des choix architecturaux
const SOURCE_PATTERN = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|cpp|c|h)$/;
const SKIP_PATTERN =
  /\.(test|spec|stories|mock|fixture)\.[jt]sx?$|\.d\.ts$|\.lock$|\.json$|\.ya?ml$|\.md$|\.env$/;

function isStructural(path: string): boolean {
  return !!path && SOURCE_PATTERN.test(path) && !SKIP_PATTERN.test(path);
}

function presentDecisions(decisions: any[]): void {
  const sep = '─'.repeat(60);
  console.log(sep);
  decisions.forEach((d, i) => {
    console.log(`\n${i + 1}. [${d.id}] ${d.title}`);
    console.log(`   Rationale  : ${d.rationale}`);
    console.log(`   Domains    : ${(d.affectedDomains ?? []).join(', ')}`);
    if (d.affectedFiles?.length) console.log(`   Files      : ${d.affectedFiles.join(', ')}`);
  });
  console.log(`\n${sep}`);
  console.log('To approve : spec-gen decisions --approve <id>');
  console.log('Then sync  : spec-gen decisions --sync');
  console.log('Then commit: git commit\n');
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const SpecGenEnforcer: Plugin = async (_ctx: any) => {
  let toolCallCount = 0;

  return {
    // ── 1. Nudge avant chaque écriture de fichier source ────────────────────
    //
    // input: { tool, sessionID, callID }
    // output: { args } — mutable (on ne modifie pas les args ici, juste nudge)
    //
    // Note : approve_decision / reject_decision sont déjà protégés côté MCP
    // par requiresHumanAuthorization. On renforce le message ici.
    //
    'tool.execute.before': async (input: any, output: any) => {
      if (input.tool === 'approve_decision') {
        console.error('\n❌ ENFORCER: approve_decision requires HUMAN authorization.');
        console.error('   Present the decision to the user and ask them to run:');
        console.error('     spec-gen decisions --approve <id>');
        console.error('     spec-gen decisions --sync');
        console.error('     git commit\n');
        return;
      }

      if (input.tool === 'reject_decision') {
        console.error('\n❌ ENFORCER: reject_decision requires HUMAN authorization.');
        console.error('   Ask the user before rejecting any decision.\n');
        return;
      }

      const isFileWrite = [
        'write_file',
        'create_file',
        'str_replace_based_edit_tool',
        'edit',
      ].includes(input.tool);
      if (!isFileWrite) return;

      // output.args contient les arguments qui seront passés au tool
      const filePath: string = output.args?.path ?? output.args?.file_path ?? '';
      if (!filePath || !isStructural(filePath)) return;

      const covered = getActiveDecisions().some((d) => (d.affectedFiles ?? []).includes(filePath));
      if (!covered) {
        console.log(`\n⚠️  ENFORCER — STRUCTURAL FILE: ${filePath}`);
        console.log('   No architectural decision recorded for this file.');
        console.log('   If this change is architectural, call record_decision FIRST.\n');
      }
    },

    // ── 2. Gate check lors des pauses de l'agent ─────────────────────────────
    //
    // session.idle est l'event émis quand le modèle s'arrête.
    // C'est le moment idéal pour vérifier l'état des décisions.
    //
    event: async ({ event }: any) => {
      if (event.type !== 'session.idle') return;

      const gate = runGate();
      if (!gate || !gate.gated) return;

      console.log('\n🔍 ENFORCER — Gate check:\n');

      if (
        gate.reason === 'no_decisions_recorded' ||
        gate.reason === 'drafts_pending_consolidation'
      ) {
        console.log('⚠️  Source files modified but decisions not yet consolidated.');
        console.log('   Run: spec-gen decisions --consolidate');
        console.log('   Then: spec-gen decisions --list\n');
        return;
      }

      if (gate.verified?.length) {
        console.log(`⛔ ${gate.verified.length} decision(s) await human approval before commit:\n`);
        presentDecisions(gate.verified);
      }
    },

    // ── 3. Rappel périodique toutes les 5 actions ─────────────────────────────
    //
    // input: { tool, sessionID, callID, args }
    // output: { title, output, metadata }
    //
    'tool.execute.after': async () => {
      toolCallCount++;
      if (toolCallCount % 5 !== 0) return;

      const pending = getActiveDecisions().filter(
        (d) => !['approved', 'synced'].includes(d.status)
      );
      if (pending.length === 0) return;

      console.log(`\n📋 DECISION REMINDER [#${toolCallCount}] — ${pending.length} pending:\n`);
      pending.forEach((d) => console.log(`   [${d.id}] ${d.title} (${d.status})`));
      console.log('\n   Verify alignment with current changes before committing.\n');
    },

    // ── 4. Préserver les décisions lors des compactions de contexte ───────────
    //
    // input: { sessionID }
    // output: { context: string[], prompt?: string } — mutable
    //
    'experimental.session.compacting': async (_input: any, output: any) => {
      const decisions = getActiveDecisions();
      if (decisions.length === 0) return;

      output.context.push(
        '## ACTIVE ARCHITECTURAL DECISIONS — DO NOT FORGET',
        '',
        ...decisions.map(
          (d) =>
            `### [${d.id}] ${d.title}\n` +
            `- Status: ${d.status}\n` +
            `- Rationale: ${d.rationale}\n` +
            `- Domains: ${(d.affectedDomains ?? []).join(', ')}\n` +
            `- Files: ${(d.affectedFiles ?? []).join(', ')}\n` +
            (d.consequences ? `- Consequences: ${d.consequences}` : '')
        ),
        '',
        '⚠️  All code changes MUST align with these decisions.',
        'To supersede: record_decision({ ..., supersedes: "<id>" })'
      );

      console.log(`\n📦 Compaction: preserving ${decisions.length} decision(s).\n`);
    },
  };
};
