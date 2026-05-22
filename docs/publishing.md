# Publishing Checklist

Use this before the first public GitHub push or any release-style PR.

## Local Privacy

- Confirm `.env` is not staged.
- Confirm `config/bot-policy.local.json` is not staged.
- Confirm `data/`, logs, pid files, OpenClaw state, and runtime backups are not staged.
- Confirm no real phone numbers, WhatsApp JIDs, emails, Twilio SIDs, or tokens appear in public files.

## Runtime Safety

- `openclaw-control` must bind to `127.0.0.1`.
- `codex-proxy` must require a bearer token by default.
- Twilio worker must not expose `/openclaw/message` when tunneled.
- Example policy may open intake with wildcards, but `defaults.mode` must stay `observe`.
- Group auto-reply must stay gated until mention/reply detection exists.

## Verification

Run:

```bash
npm run typecheck
npm run openclaw:schema-check
```

Before relying on local operations, also run:

```bash
npm run warmup
npm run warmup:status
```

## GitHub Notes

- Use `npm install`, not `npm ci`, because this repo intentionally does not commit `package-lock.json` yet.
- If a fork needs reproducible installs, commit its generated lockfile.
- Review staged files manually before the first commit.
