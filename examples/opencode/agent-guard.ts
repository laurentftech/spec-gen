/**
 * openlore Agent Guard — OpenCode plugin
 *
 * Install: openlore setup --tools opencode
 * (copies to .opencode/plugins/ — auto-loaded by OpenCode)
 *
 * What it does:
 *   1. Anti-premature-stop: injects a system-prompt rule that prevents the agent
 *      from declaring "Task completed" without having made real file changes.
 *      Once real work is done, switches to a check_spec_drift reminder instead.
 *   2. record_decision nudge: when a structural file (service/, domain/, core/, adapter/)
 *      is modified without a prior record_decision call, appends a non-blocking
 *      reminder to the tool output the agent reads.
 *   3. Compaction safety: injects pending decisions into the compaction context
 *      so they survive session summarisation.
 *   4. tool.definition enrichment: adds known spec domains to the record_decision
 *      tool description so the model uses the right domain names.
 *
 * Consolidation is NOT the plugin's responsibility.
 * The record_decision MCP handler spawns `openlore decisions --consolidate` in the
 * background automatically after saving each draft. By commit time, decisions are
 * already consolidated — the pre-commit gate does no LLM work and is instant.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

const STRUCTURAL = /\/(service|domain|core|adapter)\//

interface PendingDecision {
  id: string
  title: string
  status: string
  affectedDomains: string[]
}

async function loadPendingDecisions(directory: string): Promise<PendingDecision[]> {
  try {
    const raw = await readFile(join(directory, ".openlore", "decisions", "pending.json"), "utf-8")
    const store = JSON.parse(raw)
    return (store.decisions ?? []).filter(
      (d: PendingDecision) => !["synced", "rejected"].includes(d.status),
    )
  } catch {
    return []
  }
}

async function loadSpecDomains(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(join(directory, "openspec", "specs"), { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return []
  }
}

// Tools that write files — trigger re-analysis so the call graph stays fresh.
const EDIT_TOOL_RE = /write_file|edit_file|create_file|str_replace|insert|patch/i

// In-memory debounce: spawn at most one analysis per 10 s regardless of edit rate.
let lastAnalyzeMs = 0
const ANALYZE_DEBOUNCE_MS = 10_000

function spawnAnalyze(directory: string): void {
  const now = Date.now()
  if (now - lastAnalyzeMs < ANALYZE_DEBOUNCE_MS) return
  lastAnalyzeMs = now
  // Fire-and-forget: detached + unref so it survives plugin process exit.
  const child = spawn("openlore", ["analyze", "--output", ".openlore/analysis"], {
    detached: true,
    stdio: "ignore",
    cwd: directory,
  })
  child.unref()
}

export const AgentGuard: Plugin = async ({ directory }) => {
  const toolCalls = new Map<string, number>()
  const rdCalled = new Map<string, boolean>()
  const driftChecked = new Map<string, boolean>()

  const inc = (sid: string) => toolCalls.set(sid, (toolCalls.get(sid) ?? 0) + 1)
  const reset = (sid: string) => {
    toolCalls.set(sid, 0)
    rdCalled.set(sid, false)
    driftChecked.set(sid, false)
  }

  return {
    // Keep agent working until it has explicitly verified completion.
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      const n = toolCalls.get(sessionID) ?? 0
      const checked = driftChecked.get(sessionID) ?? false

      if (n === 0) {
        output.system.push(
          "Do not say 'Task completed', 'Done', or 'Finished' without having executed " +
          "at least one file modification tool call. If no real work has been done yet, keep working.",
        )
      } else if (!checked) {
        output.system.push(
          "Before saying 'Task completed': re-read the original request and verify every part " +
          "of it is addressed. If anything is missing or untested, keep working.",
        )
      }
    },

    // Track tool calls; nudge record_decision on structural file changes.
    "tool.execute.after": async (input, output) => {
      const { sessionID, tool, args } = input
      inc(sessionID)

      if (tool.includes("check_spec_drift")) {
        driftChecked.set(sessionID, true)
        return
      }

      if (tool.includes("record_decision")) {
        rdCalled.set(sessionID, true)
        return
      }

      const file: string = args?.filePath ?? args?.path ?? ""
      if (STRUCTURAL.test(file) && !rdCalled.get(sessionID)) {
        output.output +=
          "\n\n[openlore] Structural file modified. " +
          "Consider calling record_decision before continuing."
      }

      // Keep call graph fresh after every file edit (debounced 10 s).
      if (EDIT_TOOL_RE.test(tool)) {
        spawnAnalyze(directory)
      }
    },

    // Inject pending decisions into compaction context so they survive summarisation.
    "experimental.session.compacting": async (_input, output) => {
      const decisions = await loadPendingDecisions(directory)
      if (decisions.length > 0) {
        const lines = decisions.map(
          d => `  - [${d.status}] ${d.title} (domains: ${d.affectedDomains.join(", ")})`,
        )
        output.context.push(
          `Pending architectural decisions — do not lose track of these:\n${lines.join("\n")}`,
        )
      }
    },

    // Enrich record_decision description with known spec domains.
    "tool.definition": async ({ toolID }, output) => {
      if (!toolID.includes("record_decision")) return
      const domains = await loadSpecDomains(directory)
      if (domains.length > 0) {
        output.description +=
          `\n\nKnown affectedDomains values for this project: ${domains.join(", ")}`
      }
    },

    // Reset per-session counters on lifecycle events.
    event: async ({ event }) => {
      const sid = (event as any).properties?.sessionID
      if (sid && ["session.idle", "session.created"].includes((event as any).type)) {
        reset(sid)
      }
    },
  }
}
