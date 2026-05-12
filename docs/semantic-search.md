## Semantic Search & GraphRAG

`openlore analyze` builds a vector index over all functions in the call graph, enabling natural-language search via the `search_code`, `orient`, and `suggest_insertion_points` MCP tools, and the search bar in the viewer.

### GraphRAG retrieval expansion

Semantic search is only the starting point. openlore combines three retrieval layers into every search result — this is what makes it genuinely useful for AI agents navigating unfamiliar codebases:

1. **Semantic seed** — dense vector search (or BM25 keyword fallback) finds the top-N functions closest in meaning to the query.
2. **Call-graph expansion** — BFS up to depth 2 follows callee edges from every seed function, pulling in the files those functions depend on. During `generate`, this ensures the LLM sees the full call neighbourhood, not just the most obvious files.
3. **Spec-linked peer functions** — each seed function's spec domain is looked up in the requirement→function mapping. Functions from the same spec domain that live in *different files* are surfaced as `specLinkedFunctions`. This crosses the call-graph boundary: implementations that share a spec requirement but are not directly connected by calls are retrieved automatically.

The result: a single `orient` or `search_code` call returns not just "functions that mention this concept" but the interconnected cluster of code and specs that collectively implement it. Agents spend less time chasing cross-file references manually and more time making changes with confidence.

### Embedding configuration

Provide an OpenAI-compatible embedding endpoint (Ollama, OpenAI, Mistral, etc.) via environment variables or `.openlore/config.json`:

**Environment variables:**
```bash
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=sk-...         # optional for local servers

# Then run (embedding is automatic when configured):
openlore analyze
```

**Config file (`.openlore/config.json`):**
```json
{
  "embedding": {
    "baseUrl": "http://localhost:11434/v1",
    "model": "nomic-embed-text",
    "batchSize": 64
  }
}
```

- `batchSize`: Number of texts to embed per API call (default: 64)

The index is stored in `.openlore/analysis/vector-index/` and is automatically used by the viewer's search bar and the `search_code` / `suggest_insertion_points` MCP tools.

