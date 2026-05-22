# Responder Provider

`codex-proxy` exposes the local Codex CLI as a small OpenAI-compatible Chat Completions endpoint. The worker uses it as the responder provider.

The worker does not require the local proxy specifically. It calls an OpenAI-compatible `/chat/completions` endpoint configured by `RESPONDER_BASE_URL`, `RESPONDER_API_KEY`, and `RESPONDER_MODEL`.

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`

Streaming is not implemented.

## Run

```bash
npm run codex-proxy
npm run codex-proxy:test
```

The full project stack starts it automatically through:

```bash
npm run warmup
```

## Config

Default local Codex CLI proxy:

```text
CODEX_PROXY_ENABLED=true
CODEX_PROXY_HOST=127.0.0.1
CODEX_PROXY_PORT=8787
CODEX_PROXY_API_KEY=dev-local-change-me
CODEX_PROXY_MODEL=gpt-5.4
CODEX_PROXY_TIMEOUT_MS=120000
CODEX_PROXY_MAX_PROMPT_CHARS=20000
CODEX_PROXY_SANDBOX=read-only
CODEX_PROXY_ALLOW_WEB_SEARCH=true
CODEX_PROXY_WORKDIR=.
CODEX_PROXY_CODEX_BIN=codex.cmd
```

Worker responder defaults to the local proxy when `RESPONDER_*` is omitted:

```text
RESPONDER_BASE_URL=http://127.0.0.1:8787/v1
RESPONDER_API_KEY=dev-local-change-me
RESPONDER_MODEL=gpt-5.4
RESPONDER_TIMEOUT_MS=120000
```

Keep `WHATSAPP_ASSISTANT_DISPATCH_TIMEOUT_MS` at least as high as the responder timeout. The OpenClaw dispatch hook is synchronous; if the hook times out first, the worker may finish a valid reply that OpenClaw no longer delivers.

## Use a Direct API Key

To bypass `codex-proxy` and use a paid OpenAI-compatible API directly, set:

```text
CODEX_PROXY_ENABLED=false
RESPONDER_BASE_URL=https://api.openai.com/v1
RESPONDER_API_KEY=sk-your-api-key
RESPONDER_MODEL=your-chat-completions-model
RESPONDER_TIMEOUT_MS=60000
```

With `CODEX_PROXY_ENABLED=false`, `warmup` and `warmup:linux` skip the local proxy and `warmup:status` reports it as disabled. OpenClaw, `openclaw-control`, and `openclaw-worker` still start normally.

The direct API path is faster and more production-like, but it consumes API credits and sends message context to the configured provider. Keep the API key only in `.env` or the host secret manager.

## Voice Transcription

`codex-proxy` only handles chat completions. It does not transcribe WhatsApp audio. Profile-enabled voice notes use the separate `TRANSCRIBER_*` settings:

```text
TRANSCRIBER_BASE_URL=https://api.openai.com/v1
TRANSCRIBER_API_KEY=your-transcriber-api-key
TRANSCRIBER_MODEL=whisper-1
TRANSCRIBER_TIMEOUT_MS=60000
```

When `CODEX_PROXY_ENABLED=false`, the worker reuses `RESPONDER_API_KEY` for transcription unless `TRANSCRIBER_API_KEY` is set. With the default local proxy path, set `TRANSCRIBER_API_KEY` explicitly before enabling voice profiles in production.

## Guardrails

For the local Codex proxy:

- Binds to `127.0.0.1` by default.
- Requires a bearer token.
- Serializes requests.
- Runs `codex exec --ephemeral`.
- Uses read-only sandbox by default.
- Enables Codex `--search` only when both `CODEX_PROXY_ALLOW_WEB_SEARCH=true` and the active guidance profile has `tools.webSearch=true`.

`tools.localRead=true` is a profile-level permission for local inspection, not a global filesystem unlock. Actual file access is still constrained by Codex sandbox/config. Keep `CODEX_PROXY_SANDBOX=read-only` unless you intentionally want the responder to write files.

Do not expose this endpoint to the public internet.
