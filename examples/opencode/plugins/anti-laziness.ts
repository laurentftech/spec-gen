/**
 * anti-laziness.ts
 *
 * Plugin OpenCode — Prévention de l'arrêt prématuré sur tâches longues.
 *
 * Problème ciblé :
 *   Mistral Small / Devstral s'arrêtent dès qu'une sous-tâche est terminée
 *   même si le plan global n'est pas terminé.
 *
 * Mécanisme :
 *   1. `todo.updated` event → capture le plan dès que l'agent le crée/met à jour.
 *   2. `session.idle` event → au moment où l'agent s'arrête, vérifie si des
 *      tâches sont incomplètes et réinjecte un prompt de continuation.
 *   3. `experimental.session.compacting` → préserve le plan en mémoire lors des
 *      compactions de contexte pour éviter que l'agent oublie ses tâches.
 *
 * Safeguards :
 *   - MAX_CONTINUATIONS : évite une boucle infinie si le modèle est bloqué.
 *   - IDLE_DEBOUNCE_MS : ignore les idle très courts (transitions internes).
 *
 * Placer dans : .opencode/plugins/anti-laziness.ts
 */

import type { Plugin } from "@opencode-ai/plugin"

// ─── Config ──────────────────────────────────────────────────────────────────

const MAX_CONTINUATIONS = 8
const IDLE_DEBOUNCE_MS = 1500
const IDLE_CHECK_DELAY_MS = 800

// ─── Types ───────────────────────────────────────────────────────────────────

interface TodoItem {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed"
  priority?: "high" | "medium" | "low"
}

interface SessionState {
  plan: TodoItem[]
  continuationCount: number
  lastIdleAt: number
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const AntiLazinessPlugin: Plugin = async ({ client }) => {
  const sessions = new Map<string, SessionState>()

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function getOrCreate(sessionId: string): SessionState {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { plan: [], continuationCount: 0, lastIdleAt: 0 })
    }
    return sessions.get(sessionId)!
  }

  function pendingTasks(state: SessionState): TodoItem[] {
    return state.plan.filter(t => t.status === "pending" || t.status === "in_progress")
  }

  function buildContinuationPrompt(state: SessionState, pending: TodoItem[]): string {
    const done = state.plan.filter(t => t.status === "completed")
    const pendingList = pending
      .map((t, i) => {
        const marker = t.status === "in_progress" ? "⏳" : "◻"
        return `  ${marker} ${i + 1}. ${t.content}${t.priority ? ` [${t.priority}]` : ""}`
      })
      .join("\n")
    const doneList = done.length > 0
      ? done.map(t => `  ✓ ${t.content}`).join("\n")
      : "  (none yet)"

    return [
      `⚠️  TASK NOT COMPLETE — Continuation required (${state.continuationCount + 1}/${MAX_CONTINUATIONS})`,
      ``,
      `Progress: ${done.length}/${state.plan.length} tasks completed.`,
      ``,
      `Completed:`,
      doneList,
      ``,
      `Still pending (${pending.length} task${pending.length > 1 ? "s" : ""}):`,
      pendingList,
      ``,
      `You stopped before finishing the full plan. Continue immediately with the next pending task.`,
      `Do NOT summarize or declare "task completed" until ALL tasks above are marked done.`,
      `Start with the first ◻ task now.`,
    ].join("\n")
  }

  // ─── Hooks ─────────────────────────────────────────────────────────────────

  return {
    // ── 1. Capture du plan via l'event todo.updated ──────────────────────────
    //
    // OpenCode émet todo.updated chaque fois que l'agent crée ou met à jour
    // sa todo list — plus fiable que d'intercepter tool.execute.after sur todowrite.
    //
    event: async ({ event }: any) => {
      // Capture / mise à jour du plan
      if (event.type === "todo.updated") {
        const state = getOrCreate(event.sessionID)
        state.plan = (event.todos ?? []) as TodoItem[]
        await client.app.log({
          body: {
            service: "anti-laziness",
            level: "info",
            message: `Plan updated: ${state.plan.length} tasks, ${pendingTasks(state).length} pending`,
          },
        })
        return
      }

      // ── 2. Détection d'arrêt prématuré ──────────────────────────────────
      if (event.type === "session.idle") {
        const state = sessions.get(event.sessionID)
        if (!state || state.plan.length === 0) return

        const now = Date.now()
        if (now - state.lastIdleAt < IDLE_DEBOUNCE_MS) return
        state.lastIdleAt = now

        // Laisser le modèle finir d'écrire
        await new Promise(r => setTimeout(r, IDLE_CHECK_DELAY_MS))

        const pending = pendingTasks(state)

        if (pending.length === 0) {
          sessions.delete(event.sessionID)
          await client.app.log({
            body: { service: "anti-laziness", level: "info",
              message: `All tasks completed for session ${event.sessionID}` },
          })
          return
        }

        if (state.continuationCount >= MAX_CONTINUATIONS) {
          await client.app.log({
            body: { service: "anti-laziness", level: "warn",
              message: `Max continuations (${MAX_CONTINUATIONS}) reached — human intervention needed`,
              extra: { pending: pending.map(t => t.content) },
            },
          })
          return
        }

        state.continuationCount++
        const prompt = buildContinuationPrompt(state, pending)

        await client.app.log({
          body: { service: "anti-laziness", level: "info",
            message: `Injecting continuation ${state.continuationCount}/${MAX_CONTINUATIONS} — ${pending.length} task(s) remaining`,
          },
        })

        try {
          await client.session.prompt({
            path: { id: event.sessionID },
            body: { parts: [{ type: "text", text: prompt }] },
          })
        } catch (err: any) {
          await client.app.log({
            body: { service: "anti-laziness", level: "error",
              message: `session.prompt failed: ${err.message}` },
          })
        }
        return
      }

      // ── 3. Nettoyage à la suppression de session ─────────────────────────
      if (event.type === "session.deleted") {
        sessions.delete(event.sessionID)
      }
    },

    // ── 4. Préserver le plan lors des compactions de contexte ────────────────
    //
    // Évite que l'agent oublie ses tâches en cours quand le contexte est compressé.
    //
    "experimental.session.compacting": async (input: any, output: any) => {
      const state = sessions.get(input.sessionID)
      if (!state || state.plan.length === 0) return

      const pending = pendingTasks(state)
      if (pending.length === 0) return

      output.context.push(
        "## ACTIVE TASK PLAN — DO NOT STOP EARLY",
        "",
        `Progress: ${state.plan.length - pending.length}/${state.plan.length} tasks done.`,
        "",
        "Still pending:",
        ...pending.map(t => `- [${t.status}] ${t.content}${t.priority ? ` [${t.priority}]` : ""}`),
        "",
        "Continue with pending tasks. Do NOT declare the session complete until all tasks are done.",
      )
    },
  }
}
