# OpenClaw WhatsApp Profiles

Local-first policy and guidance layer for OpenClaw WhatsApp. It applies per-contact or per-group profiles and can generate drafts or controlled auto-replies.

The main flow is OpenClaw-only. Twilio support is included as an experimental webhook adapter for sandbox testing, not as the primary runtime.

## What It Runs

- `codex-proxy`: local OpenAI-compatible wrapper for `codex exec`.
- OpenClaw gateway: WhatsApp connection and delivery.
- `openclaw-control`: local send endpoint for manual/test sends.
- `openclaw-worker`: inbound policy/profile worker.
- Optional `whisper-local`: local `whisper.cpp` transcription server for WhatsApp voice notes.
- Optional Twilio webhook worker for sandbox testing.

All managed process logs and pid files are written under `data/runtime/`.

The responder defaults to the local `codex-proxy`, but can point directly at an OpenAI-compatible API by setting `CODEX_PROXY_ENABLED=false` and the `RESPONDER_*` variables in `.env`.

## Setup

Prerequisites:

- Node.js 20+ and npm.
- Codex CLI installed and authenticated locally.
- OpenClaw CLI available on PATH, or `OPENCLAW_COMMAND` set in `.env`.

Windows:

```bash
npm install
copy .env.example .env
copy config\bot-policy.example.json config\bot-policy.local.json
npm run warmup
npm run warmup:status
```

Linux, Orange Pi, or a small VPS:

```bash
npm install
cp .env.example .env
cp config/bot-policy.example.json config/bot-policy.local.json
npm run warmup:linux
npm run warmup:status
```

Pair WhatsApp in OpenClaw when prompted by the gateway. Keep `.env`, `data/`, and `config/bot-policy.local.json` private.

Use `npm install`, not `npm ci`. `package-lock.json` is intentionally not committed while this project is still changing quickly. Forks that run this long-term should commit their generated lockfile for reproducible installs.

## Daily Run

```bash
npm run warmup
npm run warmup:status
```

On Linux, use `npm run warmup:linux` instead of `npm run warmup`.

`warmup` and `warmup:linux` install/refresh the local OpenClaw dispatch plugin, repair the OpenClaw config for this project, and start:

- `codex-proxy` on `127.0.0.1:8787`
- OpenClaw gateway on `127.0.0.1:18789`
- `openclaw-control` on `127.0.0.1:8788`
- `openclaw-worker` on `127.0.0.1:8790`
- optional `whisper-local` on `127.0.0.1:2022` when `WHISPER_LOCAL_ENABLED=true`

To stop only processes started by the warmup manager:

```bash
npm run warmup:stop
```

On Windows, after setup, you can also double-click `start-chatbot.bat` to run warmup and status.

For 24/7 Linux hosting, first validate `warmup:linux`, then move the same services to `systemd` or another restart manager. See [Hosting](docs/operations/hosting.md).

## Policy Modes

- `observe`: log policy decisions only.
- `draft`: generate replies but do not auto-send.
- `auto`: auto-reply only when both global mode and target policy allow it.

Configure profiles and targets in `config/bot-policy.local.json`. Start from `config/bot-policy.example.json`.

The example policy opens inbound visibility with `allowContacts=["*"]` and `allowGroups=true`, but keeps `defaults.mode="observe"`. That means unknown chats are visible to the worker but do not generate replies unless you add a target or intentionally change the defaults.

Profiles can also opt into WhatsApp voice-note transcription with `voice.enabled=true`. Defaults keep voice disabled. Transcription can use an API provider through `codex-proxy` or a local `whisper.cpp` server:

```text
CODEX_PROXY_TRANSCRIBER_PROVIDER=local-whisper
WHISPER_LOCAL_ENABLED=true
WHISPER_LOCAL_MODEL=base
```

Run `npm run warmup:whisper` once to download the local binaries/model, or let `npm run warmup` start it when `WHISPER_LOCAL_ENABLED=true`.

## Manual Send

```bash
npm run openclaw:send -- --target +15551234567 --message "hello" --verbose
```

Or through the local control daemon:

```bash
curl -X POST http://127.0.0.1:8788/send -H "Content-Type: application/json" -d "{\"target\":\"+15551234567\",\"message\":\"hello\",\"verbose\":true}"
```

## Responder Provider

Default local Codex CLI proxy:

```text
CODEX_PROXY_ENABLED=true
RESPONDER_BASE_URL=http://127.0.0.1:8787/v1
RESPONDER_API_KEY=dev-local-change-me
RESPONDER_MODEL=gpt-5.4
```

Direct API key mode:

```text
CODEX_PROXY_ENABLED=false
RESPONDER_BASE_URL=https://api.openai.com/v1
RESPONDER_API_KEY=your-api-key
RESPONDER_MODEL=your-chat-completions-model
```

See [Codex proxy and responder provider](docs/operations/codex-proxy.md).

## Optional Twilio Sandbox

Twilio support is a helper path for sandbox testing. It reuses the same policy profiles and responder.

```bash
npm run twilio:worker
```

Twilio is not started by `warmup`; run it separately. Expose only `http://127.0.0.1:8791/twilio/whatsapp` through a tunnel and configure that URL as the Twilio inbound webhook. The Twilio worker disables the OpenClaw `/openclaw/message` route on that port. For tunneled testing, keep `TWILIO_VALIDATE_SIGNATURE=true` and set `TWILIO_AUTH_TOKEN` plus `TWILIO_WEBHOOK_URL`. Do not commit real Twilio credentials.

## Docs

- [Architecture](docs/architecture.md)
- [OpenClaw operations](docs/operations/openclaw.md)
- [Guidance profiles](docs/operations/guidance-profiles.md)
- [Codex proxy](docs/operations/codex-proxy.md)
- [Hosting](docs/operations/hosting.md)
- [Security](docs/security.md)
- [Product direction](docs/product-direction.md)
