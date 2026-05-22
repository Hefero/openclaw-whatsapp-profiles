# Responder Provider

The worker calls an OpenAI-compatible `/chat/completions` endpoint configured by `RESPONDER_BASE_URL`, `RESPONDER_API_KEY`, and `RESPONDER_MODEL`.

The public/default setup is direct API key mode. `codex-proxy` is optional for users who want to back replies with a local Codex CLI session or run local Whisper transcription behind a local OpenAI-compatible endpoint.

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/audio/transcriptions`

Streaming is not implemented.

## Direct API Mode

Default public setup:

```text
CODEX_PROXY_ENABLED=false
RESPONDER_BASE_URL=https://api.openai.com/v1
RESPONDER_API_KEY=your-api-key
RESPONDER_MODEL=gpt-4o-mini
RESPONDER_TIMEOUT_MS=60000
```

This path does not require Codex CLI or a ChatGPT/Codex subscription. It consumes API credits from the configured provider and sends message context to that provider. Keep the API key only in `.env` or the host secret manager.

## Optional Codex Proxy

`codex-proxy` exposes the local Codex CLI as a small OpenAI-compatible Chat Completions endpoint.

```bash
npm run codex-proxy
npm run codex-proxy:test
```

The full project stack starts it automatically only when:

```text
CODEX_PROXY_ENABLED=true
```

Local Codex CLI proxy config:

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
CODEX_PROXY_TRANSCRIBER_PROVIDER=off
```

Point the responder at the proxy:

```text
RESPONDER_BASE_URL=http://127.0.0.1:8787/v1
RESPONDER_API_KEY=dev-local-change-me
RESPONDER_MODEL=gpt-5.4
RESPONDER_TIMEOUT_MS=120000
```

Keep `WHATSAPP_ASSISTANT_DISPATCH_TIMEOUT_MS` at least as high as the responder timeout. The OpenClaw dispatch hook is synchronous; if the hook times out first, the worker may finish a valid reply that OpenClaw no longer delivers.

## Voice Transcription

`codex-proxy` can also expose an OpenAI-compatible `/v1/audio/transcriptions` endpoint. It does not use `codex exec` for audio; it forwards the multipart transcription request to a configured transcription backend.

Local Whisper path:

```text
CODEX_PROXY_ENABLED=true
CODEX_PROXY_TRANSCRIBER_PROVIDER=local-whisper
CODEX_PROXY_TRANSCRIBER_BASE_URL=http://127.0.0.1:2022/v1
CODEX_PROXY_TRANSCRIBER_MODEL=base
WHISPER_LOCAL_ENABLED=true
WHISPER_LOCAL_MODEL=base
TRANSCRIBER_BASE_URL=http://127.0.0.1:8787/v1
TRANSCRIBER_API_KEY=dev-local-change-me
TRANSCRIBER_MODEL=base
TRANSCRIBER_TIMEOUT_MS=60000
```

Run:

```bash
npm run warmup:whisper
npm run warmup
```

On Windows, `warmup:whisper` downloads a portable `whisper.cpp` release, the `base` model, and a portable FFmpeg build under `data/whisper/`. Nothing from that directory should be committed.

See [Voice notes](voice-notes.md) for the full operational test path and troubleshooting.

OpenAI transcription path:

```text
CODEX_PROXY_ENABLED=true
CODEX_PROXY_TRANSCRIBER_PROVIDER=openai
CODEX_PROXY_TRANSCRIBER_API_KEY=your-transcriber-api-key
CODEX_PROXY_TRANSCRIBER_MODEL=gpt-4o-mini-transcribe
TRANSCRIBER_BASE_URL=http://127.0.0.1:8787/v1
TRANSCRIBER_API_KEY=dev-local-change-me
TRANSCRIBER_MODEL=gpt-4o-mini-transcribe
```

When `CODEX_PROXY_ENABLED=false`, the worker can bypass `codex-proxy` and call the configured `TRANSCRIBER_BASE_URL` directly. In that mode it reuses `RESPONDER_API_KEY` for transcription unless `TRANSCRIBER_API_KEY` is set.

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
