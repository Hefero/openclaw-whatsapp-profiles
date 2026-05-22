# Agent Notes

This project is OpenClaw-only for the main WhatsApp flow.

Use these commands for operational warmup:

```bash
cmd /c npm run warmup
cmd /c npm run warmup:status
```

On Linux/Orange Pi/VPS:

```bash
npm run warmup:linux
npm run warmup:status
```

Managed processes:

- `codex-proxy` on `127.0.0.1:8787`
- OpenClaw gateway on `127.0.0.1:18789`
- `openclaw-control` on `127.0.0.1:8788`
- `openclaw-worker` inbound HTTP bridge on `127.0.0.1:8790`

The warmup command installs or refreshes the local OpenClaw dispatch plugin.
`warmup:linux` only stops processes recorded under `data/runtime/`; it fails if
project ports are owned by unknown processes.

Logs and pid files are under `data/runtime/`.

To stop only processes started by the warmup manager:

```bash
cmd /c npm run warmup:stop
```

To fully sanitize stale project processes before a fresh start:

```bash
cmd /c npm run warmup
cmd /c npm run warmup:status
```

`warmup` already sanitizes stale project ports before starting managed processes.

Do not add alternate WhatsApp adapters back into the main path.
