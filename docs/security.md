# Security

## Private Files

Never commit:

- `.env`
- `data/`
- `config/bot-policy.local.json`
- OpenClaw account/session state
- runtime logs containing message metadata

These paths are ignored by `.gitignore`.

Before the first public commit, run a staged-files review and confirm none of those paths were force-added.

## Secrets

Rotate any credential that was ever committed or pasted into a public issue/log. For normal local use, keep Twilio tokens, proxy keys, direct responder API keys, OpenClaw state, and policy targets only in ignored local files.

## Message Data

Runtime state and logs may contain contact identifiers, message ids, profile names, and truncated reply data. Treat `data/` as private local state.

## Network Exposure

- Keep `openclaw-control`, `openclaw-worker`, and any optional local proxy bound to localhost.
- Do not expose `codex-proxy` directly to the internet when it is enabled.
- If using Twilio, expose only the Twilio webhook path through a tunnel and keep signature validation enabled for non-local testing.
- Treat `openclaw-control` as a local-only send API. It has no authentication by default.

## Acceptable Use

Do not use this project for spam, contact scraping, mass messaging, or messaging people without consent. For business/compliance use cases, use official WhatsApp Business APIs and opt-in flows.
