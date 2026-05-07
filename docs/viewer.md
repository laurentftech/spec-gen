## Interactive Graph Viewer

`spec-gen view` launches a local React app that visualises your codebase analysis and lets you explore spec requirements side-by-side with the dependency graph.

```bash
# Run analysis first (if not already done)
spec-gen analyze

# Launch the viewer (opens browser automatically)
spec-gen view

# Options
spec-gen view --port 4000          # custom port (default: 5173)
spec-gen view --host 0.0.0.0       # expose on LAN
spec-gen view --no-open            # don't open browser automatically
spec-gen view --analysis <path>    # custom analysis dir (default: .spec-gen/analysis/)
spec-gen view --spec <path>        # custom spec dir (default: ./openspec/specs/)
```

### Views

| View | Description |
|------|-------------|
| **Clusters** | Colour-coded architectural clusters with expandable member nodes. Falls back to directory clusters for languages without import edges (Swift, C++) |
| **Flat** | Force-directed dependency graph (all nodes). Import edges are solid; call edges (Swift/C++ synthesised, or HTTP cross-language) are cyan dashed |
| **Classes** | Class/struct inheritance and call graph. Nodes coloured by language or connected component; isolated nodes hidden. Component-aware force layout keeps related classes together |
| **Architecture** | High-level cluster map: role-coloured boxes, inter-cluster dependency arrows |
| **Classes** | Component-aware force layout of class/struct relationships with coloured groupings |

### Diagram Chat

The right sidebar includes a **Diagram Chat** panel powered by an LLM agent. The chat can access all analysis tools and interact with the graph:

- Ask questions about your codebase in natural language
- Graph functions and requirements mentioned in answers are automatically highlighted
- Clusters containing highlighted nodes auto-expand to reveal the nodes
- Select a node in the chat to view its details tab

Example queries:
- "What are the most critical functions?"
- "Where would I add a new API endpoint?"
- "Show me the impact of changing the authentication service"

The chat requires an LLM API key (same provider configuration as `spec-gen generate`). Viewer-only operations like graph browsing, skeleton view, and search do not require an API key.

### Right panel tabs (select a node to activate)

| Tab | Content |
|-----|---------|
| **Node** | File metadata: exports, language, score |
| **Links** | Direct callers and callees |
| **Blast** | Downstream impact radius |
| **Spec** | Requirements linked to the selected file -- body, domain, confidence |
| **Skeleton** | Noise-stripped source: logs and comments removed, structure preserved |
| **Info** | Global stats and top-ranked files |

### Search

The search bar filters all three views simultaneously (text match on name, path, exports, tags). If a vector index was built with `--embed`, typing >= 3 characters also queries the semantic index and shows the top 5 function matches in a dropdown.

### Automatic data loading

The viewer auto-loads all available data on startup:

| Endpoint | Source | Required? |
|----------|--------|-----------|
| `/api/dependency-graph` | `.spec-gen/analysis/dependency-graph.json` | Yes |
| `/api/llm-context` | `.spec-gen/analysis/llm-context.json` | No |
| `/api/refactor-priorities` | `.spec-gen/analysis/refactor-priorities.json` | No |
| `/api/mapping` | `.spec-gen/analysis/mapping.json` | No |
| `/api/spec-requirements` | `openspec/specs/**/*.md` + `mapping.json` | No |
| `/api/skeleton?file=` | Source file on disk | No |
| `/api/search?q=` | `.spec-gen/analysis/vector-index/` | No (`--embed`) |

Run `spec-gen generate` to produce `mapping.json` and the spec files. Once present, the **Spec** tab shows the full requirement body for each selected file.

### View Options

```bash
spec-gen view [options]
  --analysis <path>    Analysis directory (default: .spec-gen/analysis/)
  --spec <path>        Spec files directory (default: ./openspec/specs/)
  --port <n>           Port (default: 5173)
  --host <host>        Bind host (default: 127.0.0.1; use 0.0.0.0 for LAN)
  --no-open            Skip automatic browser open
```

