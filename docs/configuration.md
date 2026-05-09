## Configuration

`spec-gen init` creates `.spec-gen/config.json`:

```json
{
  "version": "1.0.0",
  "projectType": "nodejs",
  "openspecPath": "./openspec",
  "analysis": {
    "maxFiles": 500,
    "includePatterns": [],
    "excludePatterns": []
  },
  "generation": {
    "model": "claude-sonnet-4-20250514",
    "domains": "auto"
  }
}
```

### Environment Variables

| Variable | Provider | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | `anthropic` | Anthropic API key |
| `ANTHROPIC_API_BASE` | `anthropic` | Custom base URL (proxy / self-hosted) |
| `OPENAI_API_KEY` | `openai` | OpenAI API key |
| `OPENAI_API_BASE` | `openai` | Custom base URL (Azure, proxy...) |
| `OPENAI_COMPAT_API_KEY` | `openai-compat` | API key for OpenAI-compatible server |
| `OPENAI_COMPAT_BASE_URL` | `openai-compat` | Base URL, e.g. `https://api.mistral.ai/v1` |
| `GEMINI_API_KEY` | `gemini` | Google Gemini API key |
| `COPILOT_API_BASE_URL` | `copilot` | Base URL of the copilot-api proxy (default: `http://localhost:4141/v1`) |
| `COPILOT_API_KEY` | `copilot` | API key if the proxy requires auth (default: `copilot`) |
| `EMBED_BASE_URL` | embedding | Base URL for the embedding API (e.g. `http://localhost:11434/v1`) |
| `EMBED_MODEL` | embedding | Embedding model name (e.g. `nomic-embed-text`) |
| `EMBED_API_KEY` | embedding | API key for the embedding service (defaults to `OPENAI_API_KEY`) |
| `DEBUG` | -- | Enable stack traces on errors |
| `CI` | -- | Auto-detected; enables timestamps in output |

