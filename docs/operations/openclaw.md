# OpenClaw Operations

## First Setup

Windows is the supported one-command path today:

```bash
npm install
copy .env.example .env
copy config\bot-policy.example.json config\bot-policy.local.json
npm run warmup
npm run warmup:status
```

The OpenClaw gateway must be paired with WhatsApp. Use the QR/pairing flow printed by OpenClaw when the gateway starts.

## Managed Services

`npm run warmup` starts the project stack:

- `codex-proxy`: `http://127.0.0.1:8787/healthz`
- OpenClaw gateway: `127.0.0.1:18789`
- `openclaw-control`: `http://127.0.0.1:8788/healthz`
- `openclaw-worker`: `http://127.0.0.1:8790/healthz`

Logs and pid files are under `data/runtime/`.

## Commands

```bash
npm run warmup
npm run warmup:status
npm run warmup:stop
```

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
- Visible replies set to automatic.
- Direct-message intake opened when `allowContacts` contains `*`.
- Group intake opened when `allowGroups=true`.
- Otherwise, WhatsApp allowlists are synced from explicit contact targets.

Backups are written under `data/runtime/openclaw-config-backups/`.

## Troubleshooting

- If inbound replies stop, run `npm run warmup:status` and check `data/runtime/openclaw-worker.log`.
- If sends fail, check the gateway status and `data/runtime/openclaw-gateway.log`.
- If model calls fail, check `data/runtime/codex-proxy.log`.
- If plugin setup fails, run `npm run openclaw:install-whatsapp`, `npm run openclaw:install-dispatch-plugin`, then `npm run openclaw:repair-config`.
- Keep `codex-proxy` and worker endpoints bound to localhost unless you add private networking and authentication.
