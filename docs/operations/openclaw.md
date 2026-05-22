# OpenClaw Operations

## First Setup

Windows is the supported one-command path today:

```bash
npm install
copy .env.example .env
copy config\bot-policy.example.json config\bot-policy.local.json
```

Edit `.env` and set at least `RESPONDER_API_KEY`, then start:

```bash
npm run warmup
npm run warmup:status
```

The OpenClaw gateway must be paired with WhatsApp. Use the QR/pairing flow printed by OpenClaw when the gateway starts.

## Managed Services

`npm run warmup` starts the project stack:

- OpenClaw gateway: `127.0.0.1:18789`
- `openclaw-control`: `http://127.0.0.1:8788/healthz`
- `openclaw-worker`: `http://127.0.0.1:8790/healthz`
- optional `codex-proxy`: `http://127.0.0.1:8787/healthz` when `CODEX_PROXY_ENABLED=true`
- optional `whisper-local`: `127.0.0.1:2022` when `WHISPER_LOCAL_ENABLED=true`

Logs and pid files are under `data/runtime/`.

## Commands

```bash
npm run warmup
npm run warmup:status
npm run warmup:stop
npm run warmup:whisper
```

Use `warmup:whisper` to install/start the optional local Whisper server for voice notes. When `WHISPER_LOCAL_ENABLED=true`, `npm run warmup` starts it with the rest of the stack.

## Manual Send

```bash
npm run openclaw:send -- --target +15551234567 --message "hello" --verbose
```

For groups, use the real OpenClaw/WhatsApp group target. Do not pass an empty group field when sending a direct message.

With the control daemon running:

```bash
curl -X POST http://127.0.0.1:8788/send -H "Content-Type: application/json" -d "{\"target\":\"+15551234567\",\"message\":\"hello\",\"verbose\":true}"
```

## Config Repair

```bash
npm run openclaw:repair-config
```

This keeps the OpenClaw config aligned with the project policy:

- WhatsApp channel enabled.
- Local dispatch plugin enabled.
- Local dispatch plugin timeout set from `WHATSAPP_ASSISTANT_DISPATCH_TIMEOUT_MS` (default `120000`).
- Visible replies set to automatic.
- Direct-message intake opened when `allowContacts` contains `*`.
- Group intake opened when `allowGroups=true`.
- Otherwise, WhatsApp allowlists are synced from explicit contact targets.

Backups are written under `data/runtime/openclaw-config-backups/`.

## Troubleshooting

- If inbound replies stop, run `npm run warmup:status` and check `data/runtime/openclaw-worker.log`.
- If a profile uses web search and the worker produces a reply but WhatsApp gets nothing, check for `This operation was aborted` in `data/runtime/openclaw-gateway.log`; raise `WHATSAPP_ASSISTANT_DISPATCH_TIMEOUT_MS` if needed.
- If sends fail, check the gateway status and `data/runtime/openclaw-gateway.log`.
- If model calls fail in direct API mode, check the worker log and `RESPONDER_*` settings.
- If model calls fail in Codex proxy mode, check `data/runtime/codex-proxy.log`.
- If voice-note transcription fails, check `data/runtime/whisper-local.log` and [Voice notes](voice-notes.md).
- If plugin setup fails, run `npm run openclaw:install-whatsapp`, `npm run openclaw:install-dispatch-plugin`, then `npm run openclaw:repair-config`.
- Keep local proxy and worker endpoints bound to localhost unless you add private networking and authentication.
