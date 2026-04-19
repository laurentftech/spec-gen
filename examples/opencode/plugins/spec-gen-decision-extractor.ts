/**
 * spec-gen-decision-extractor.ts
 *
 * Plugin OpenCode : extraction proactive des décisions architecturales via le
 * Librarian agent d'oh-my-openagent.
 *
 * Mécanisme :
 *   1. tool.execute.after — détecte les écritures de fichiers source et
 *      enregistre les candidats à analyser.
 *   2. session.idle (agent principal) — pour chaque fichier en attente, spawn
 *      une session Librarian. Le Librarian analyse le changement et, s'il
 *      détecte une décision architecturale, appelle record_decision via le MCP
 *      spec-gen directement. Pas de parsing de réponse nécessaire.
 *   3. session.idle (session Librarian) — nettoyage de la session Librarian.
 *
 * Fallback : si l'agent "librarian" n'est pas disponible (oh-my-openagent non
 * installé), le plugin se replie sur un appel HTTP direct à un endpoint
 * OpenAI-compatible configuré via env vars.
 *
 * Env vars fallback :
 *   OPENAI_BASE_URL         — défaut: http://localhost:11434/v1 (Ollama)
 *   OPENAI_API_KEY          — défaut: "ollama"
 *   OPENAI_MODEL_EXTRACTOR  — défaut: mistral-small-latest
 *
 * Placer dans : .opencode/plugins/spec-gen-decision-extractor.ts
 */

import { execSync } from "child_process"
import { readFileSync } from "fs"
import { join } from "path"
import type { Plugin } from "@opencode-ai/plugin"

// ─── Config ──────────────────────────────────────────────────────────────────

// Fallback si oh-my-openagent / Librarian non disponible
const FALLBACK_BASE_URL = process.env.OPENAI_BASE_URL ?? "http://localhost:11434/v1"
const FALLBACK_API_KEY = process.env.OPENAI_API_KEY ?? "ollama"
const FALLBACK_MODEL = process.env.OPENAI_MODEL_EXTRACTOR ?? "mistral-small-latest"

const SPEC_GEN_BIN = resolveSpecGen()

function resolveSpecGen(): string {
  for (const c of ["node_modules/.bin/spec-gen", "dist/cli/index.js"]) {
    try {
      execSync(`test -f ${c}`, { stdio: "pipe" })
      return c.endsWith(".js") ? `node ${c}` : c
    } catch {}
  }
  return "spec-gen"
}

// Fichiers source à surveiller
const SOURCE_PATTERN = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|cpp|c|h)$/
const SKIP_PATTERN =
  /\.(test|spec|stories|mock|fixture)\.[jt]sx?$|\.d\.ts$|\.lock$|\.json$|\.ya?ml$|\.md$|\.env$/

// Seuils de scoring pour le pre-filtrage dep-graph
// Un fichier est "définitivement architectural" si l'un des critères est vrai
const HUB_INDEGREE = 3       // ≥ 3 fichiers l'importent
const HIGH_PAGERANK = 0.4    // PageRank normalisé ≥ 40%
const HIGH_FILE_SCORE = 0.65 // Significance score ≥ 65%

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseJSON<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim())
  } catch {
    return null
  }
}

function run(args: string): string {
  try {
    return execSync(`${SPEC_GEN_BIN} ${args}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (e: any) {
    return e.stdout ?? ""
  }
}

function getActiveDecisions(): any[] {
  return parseJSON<any[]>(run("decisions --list --json")) ?? []
}

function getSpecDomains(): string[] {
  try {
    return execSync("ls openspec/specs/", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .split("\n")
      .filter(Boolean)
  } catch {
    return []
  }
}

function isSource(filePath: string): boolean {
  return SOURCE_PATTERN.test(filePath) && !SKIP_PATTERN.test(filePath)
}

function alreadyCovered(filePath: string): boolean {
  return getActiveDecisions().some(d => (d.affectedFiles ?? []).includes(filePath))
}

// ─── Dep-graph scoring ───────────────────────────────────────────────────────

interface FileScore {
  inDegree: number
  pageRank: number
  fileScore: number
  isHub: boolean
}

/**
 * Read the dep-graph and score a file by its structural centrality.
 * Returns null if the file is not in the graph (new file — treat as unknown).
 * Exported for testing.
 */
export function scoreFromDepGraph(filePath: string, rootDir = process.cwd()): FileScore | null {
  try {
    const raw = readFileSync(
      join(rootDir, ".spec-gen", "analysis", "dependency-graph.json"),
      "utf-8",
    )
    const graph = JSON.parse(raw)
    const nodes: any[] = graph.nodes ?? []

    // Match by relative path or absolute path suffix
    const node = nodes.find(
      n => n.file?.path === filePath || n.id === filePath || n.file?.path?.endsWith(filePath),
    )
    if (!node) return null

    const inDegree: number = node.metrics?.inDegree ?? 0
    const pageRank: number = node.metrics?.pageRank ?? 0
    const fileScore: number = node.file?.score ?? 0

    return {
      inDegree,
      pageRank,
      fileScore,
      isHub: inDegree >= HUB_INDEGREE || pageRank >= HIGH_PAGERANK || fileScore >= HIGH_FILE_SCORE,
    }
  } catch {
    return null
  }
}

// Prompt envoyé au Librarian (ou au fallback LLM)
function buildPrompt(filePath: string, content: string, score: FileScore | null): string {
  const domains = getSpecDomains()

  const scoreContext = score
    ? [
        `STRUCTURAL CONTEXT (from static analysis):`,
        `  inDegree  : ${score.inDegree} file(s) import this file`,
        `  pageRank  : ${(score.pageRank * 100).toFixed(0)}% (normalized importance)`,
        `  fileScore : ${(score.fileScore * 100).toFixed(0)}% (significance score)`,
        score.isHub
          ? `  → This is a HUB file. Lean toward recording a decision.`
          : `  → Low centrality. Only record if clearly architectural.`,
      ].join("\n")
    : `STRUCTURAL CONTEXT: File not found in dep-graph (new file — treat as potentially architectural).`

  return [
    `You are an architectural decision detector for a spec-driven development project.`,
    ``,
    `FILE: ${filePath}`,
    `KNOWN SPEC DOMAINS: ${domains.join(", ") || "unknown"}`,
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
    `If architectural: call record_decision with:`,
    `  title           — max 10 words`,
    `  rationale       — 2-3 sentences explaining the why`,
    `  affectedDomains — domain names from the list above`,
    `  affectedFiles   — ["${filePath}"]`,
    `  consequences    — 1-2 sentences on downstream impact`,
    ``,
    `If NOT architectural: reply only "Not architectural." and stop.`,
    ``,
    `Be decisive. One record_decision call maximum. Do not overthink.`,
  ].join("\n")
}

// ─── Fallback : appel HTTP direct OpenAI-compatible ─────────────────────────

async function fallbackExtract(filePath: string, content: string): Promise<void> {
  const prompt = buildPrompt(filePath, content)

  try {
    const res = await fetch(`${FALLBACK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FALLBACK_API_KEY}`,
      },
      body: JSON.stringify({
        model: FALLBACK_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 350,
      }),
    })

    if (!res.ok) return

    const data = await res.json()
    const text: string = data?.choices?.[0]?.message?.content ?? ""

    if (text.trim().startsWith("Not architectural")) return

    // Extraire la décision suggérée et la logguer pour que l'agent la voit
    const decision = parseJSON<any>(text)
    if (!decision) return

    console.log(`\n💡 DECISION EXTRACTOR (fallback) — Architectural change in ${filePath}:`)
    console.log(`   Title    : ${decision.title}`)
    console.log(`   Rationale: ${decision.rationale}`)
    console.log(`\n   → Call record_decision:\n`)
    console.log(
      JSON.stringify(
        {
          title: decision.title,
          rationale: decision.rationale,
          affectedDomains: decision.affectedDomains,
          affectedFiles: [filePath],
          consequences: decision.consequences,
        },
        null,
        2,
      ).replace(/^/gm, "     "),
    )
  } catch {
    // Non-bloquant
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const SpecGenDecisionExtractor: Plugin = async ({ client }) => {
  // Fichiers en attente d'analyse : filePath → { content, score }
  const pending = new Map<string, { content: string; score: FileScore | null }>()

  // Sessions Librarian actives : libSessionId → filePath
  const librarianSessions = new Map<string, string>()

  return {
    // ── Enrichir record_decision avec les domaines connus ────────────────────
    //
    // input: { toolID }
    // output: { description, parameters } — mutable
    //
    "tool.definition": async (input: any, output: any) => {
      if (input.toolID !== "record_decision") return
      const domains = getSpecDomains()
      if (domains.length === 0) return
      output.description =
        (output.description ?? "") +
        `\n\nKnown spec domains: ${domains.join(", ")}. Use these exact names in affectedDomains.`
    },

    // ── Collecte des fichiers à analyser ─────────────────────────────────────
    //
    // input: { tool, sessionID, callID, args }
    // output: { title, output, metadata }
    //
    "tool.execute.after": async (input: any, output: any) => {
      const isFileWrite = [
        "write_file",
        "create_file",
        "str_replace_based_edit_tool",
        "edit",
      ].includes(input.tool)
      if (!isFileWrite) return

      const filePath: string = input.args?.path ?? input.args?.file_path ?? ""
      if (!filePath || !isSource(filePath) || alreadyCovered(filePath)) return

      const score = scoreFromDepGraph(filePath)

      // Fichier connu du graph avec score très faible : probablement pas architectural
      // (inDegree=0, pageRank<0.1, fileScore<0.3) — on skip pour économiser un appel LLM
      if (
        score !== null &&
        score.inDegree === 0 &&
        score.pageRank < 0.1 &&
        score.fileScore < 0.3
      ) {
        return
      }

      // Enqueue pour analyse au prochain idle
      pending.set(filePath, { content: output.output ?? "", score })
    },

    event: async ({ event }: any) => {
      // ── Spawn Librarian sur idle de la session principale ─────────────────
      //
      // On attend que l'agent principal s'arrête pour lancer les analyses,
      // évitant d'interférer avec son travail en cours.
      //
      if (event.type === "session.idle" && !librarianSessions.has(event.sessionID)) {
        if (pending.size === 0) return

        for (const [filePath, { content, score }] of pending) {
          pending.delete(filePath)

          const prompt = buildPrompt(filePath, content, score)

          try {
            // Spawn une session Librarian.
            // agent: "librarian" est le nom oh-my-openagent de l'agent léger
            // de recherche/analyse. Il a accès au MCP spec-gen et peut appeler
            // record_decision directement, sans qu'on ait à parser sa réponse.
            const res = await (client as any).session.create({
              body: {
                agent: "librarian",
                // Titre lisible dans l'UI OpenCode
                title: `[spec-gen] decision-check: ${filePath.split("/").pop()}`,
              },
            })

            const libSessionId: string | undefined = res?.data?.id ?? res?.id
            if (!libSessionId) {
              // Librarian non disponible → fallback HTTP
              await fallbackExtract(filePath, content)
              continue
            }

            librarianSessions.set(libSessionId, filePath)

            await (client as any).session.prompt({
              path: { id: libSessionId },
              body: { parts: [{ type: "text", text: prompt }] },
            })

            await client.app.log({
              body: {
                service: "decision-extractor",
                level: "info",
                message: `Librarian session ${libSessionId} analyzing ${filePath}`,
              },
            })
          } catch {
            // Fallback si oh-my-openagent / agent "librarian" non disponible
            await fallbackExtract(filePath, content)
          }
        }
        return
      }

      // ── Nettoyage des sessions Librarian terminées ────────────────────────
      if (event.type === "session.idle" && librarianSessions.has(event.sessionID)) {
        const filePath = librarianSessions.get(event.sessionID)!
        librarianSessions.delete(event.sessionID)

        await client.app.log({
          body: {
            service: "decision-extractor",
            level: "info",
            message: `Librarian done for ${filePath} — session ${event.sessionID}`,
          },
        })

        // Supprimer la session Librarian pour ne pas polluer l'historique
        try {
          await (client as any).session.delete({
            path: { id: event.sessionID },
          })
        } catch {
          // Non-bloquant
        }
        return
      }

      // Nettoyage si session principale supprimée
      if (event.type === "session.deleted") {
        pending.clear()
      }
    },
  }
}
