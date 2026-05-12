## LLM Providers

openlore supports nine providers. The default is Anthropic Claude.

| Provider | `provider` value | API key env var | Default model |
|----------|-----------------|-----------------|---------------|
| Anthropic Claude | `anthropic` *(default)* | `ANTHROPIC_API_KEY` | `claude-sonnet-4-20250514` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o` |
| OpenAI-compatible *(Mistral, Groq, Ollama...)* | `openai-compat` | `OPENAI_COMPAT_API_KEY` | `mistral-large-latest` |
| GitHub Copilot *(via copilot-api proxy)* | `copilot` | *(none)* | `gpt-4o` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.0-flash` |
| Gemini CLI | `gemini-cli` | *(none)* | *(CLI default)* |
| Claude Code | `claude-code` | *(none)* | *(CLI default)* |
| Mistral Vibe | `mistral-vibe` | *(none)* | *(CLI default)* |
| Cursor Agent CLI | `cursor-agent` | *(none)* | *(CLI default)* |

### Selecting a provider

Set `provider` (and optionally `model`) in the `generation` block of `.openlore/config.json`:

```json
{
  "generation": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "domains": "auto"
  }
}
```

Override the model for a single run:
```bash
openlore generate --model claude-opus-4-20250514
```

### OpenAI-compatible servers (Ollama, Mistral, Groq, LM Studio, vLLM...)

Use `provider: "openai-compat"` with a base URL and API key:

**Environment variables:**
```bash
export OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1   # Ollama, LM Studio, local servers
export OPENAI_COMPAT_API_KEY=ollama                       # any non-empty value for local servers
                                                          # use your real API key for cloud providers (Mistral, Groq...)
```

**Config file** (per-project):
```json
{
  "generation": {
    "provider": "openai-compat",
    "model": "llama3.2",
    "openaiCompatBaseUrl": "http://localhost:11434/v1",
    "domains": "auto"
  }
}
```

**Self-signed certificates** (internal servers, VPN endpoints):
```bash
openlore generate --insecure
```
Or in `config.json`:
```json
{
  "generation": {
    "provider": "openai-compat",
    "openaiCompatBaseUrl": "https://internal-llm.corp.net/v1",
    "skipSslVerify": true,
    "domains": "auto"
  }
}
```

**Proxies that don't support `response_format`** (vLLM, custom gateways):

Some endpoints reject requests that include `response_format` with an error like
`{"detail":"There was an error parsing the body"}`. Set `disableResponseFormat: true`
to omit that field — the model still produces JSON via the system prompt:

```json
{
  "generation": {
    "provider": "openai-compat",
    "openaiCompatBaseUrl": "https://your-gateway.corp.net/v1",
    "disableResponseFormat": true,
    "domains": "auto"
  }
}
```

Works with: Ollama, LM Studio, Mistral AI, Groq, Together AI, LiteLLM, vLLM,
text-generation-inference, LocalAI, Azure OpenAI, and any `/v1/chat/completions` server.

### GitHub Copilot (via copilot-api proxy)

Use `provider: "copilot"` to generate specs using your GitHub Copilot subscription via the
[copilot-api](https://github.com/ericc-ch/copilot-api) proxy, which exposes an OpenAI-compatible
endpoint from your Copilot credentials.

**Setup:**
1. Install and start the copilot-api proxy:
   ```bash
   npx copilot-api
   ```
   By default it listens on `http://localhost:4141`.

2. Configure openlore:
   ```json
   {
     "generation": {
       "provider": "copilot",
       "model": "gpt-4o",
       "domains": "auto"
     }
   }
   ```

**Environment variables** (optional):
```bash
export COPILOT_API_BASE_URL=http://localhost:4141/v1   # default
export COPILOT_API_KEY=copilot                         # default, only needed if proxy requires auth
```

No API key is required — the copilot-api proxy handles authentication via your GitHub Copilot session.

### CLI-based providers (no API key)

Four providers route LLM calls through local CLI tools instead of HTTP APIs. No API key or configuration is needed — just have the CLI installed and on your PATH.

| Provider | CLI binary | Install |
|----------|-----------|----------------|
| `claude-code` | `claude` | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (requires Claude Max/Pro subscription) |
| `gemini-cli` | `gemini` | [Gemini CLI](https://github.com/google-gemini/gemini-cli) (free tier with Google account) |
| `mistral-vibe` | `vibe` | [Mistral Vibe](https://github.com/mistralai/mistral-vibe) (standalone binary) |
| `cursor-agent` | `cursor-agent` | [Cursor CLI](https://cursor.com/docs/cli/overview) (Cursor subscription / CLI auth) |

```json
{
  "generation": {
    "provider": "claude-code",
    "domains": "auto"
  }
}
```

### Custom base URL for Anthropic or OpenAI

To redirect the built-in Anthropic or OpenAI provider to a proxy or self-hosted endpoint:

```bash
# CLI (one-off)
openlore generate --api-base https://my-proxy.corp.net/v1

# Environment variable
export ANTHROPIC_API_BASE=https://my-proxy.corp.net/v1
export OPENAI_API_BASE=https://my-proxy.corp.net/v1
```

Or in `config.json` under the `llm` block:
```json
{
  "llm": {
    "apiBase": "https://my-proxy.corp.net/v1",
    "sslVerify": false
  }
}
```

`sslVerify: false` disables TLS certificate validation -- use only for internal servers with self-signed certificates.

Priority: CLI flags > environment variables > config file > provider defaults.

