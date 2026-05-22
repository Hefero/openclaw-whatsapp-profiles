# Product Direction

This repository is currently personal-first.

## Current Project

Working title: Personal WhatsApp Assistant.

Scope:

- Local-first personal WhatsApp automation.
- OpenClaw as the main WhatsApp adapter.
- Per-contact and per-group policy profiles.
- Observe/draft/auto modes with delivery gates.
- Local Codex proxy as the default responder provider.

This path optimizes for privacy, explicit local control, and a small number of trusted personal conversations.

## Future Split

The policy/profile core can become a second product later.

Working title: WhatsApp Agent Engine.

Scope:

- Webhook-first channel adapters such as Twilio or WhatsApp Business APIs.
- Business profiles and workflow-specific policies.
- Provider-agnostic LLM routing.
- Handoff, opt-in, audit, retention, and compliance controls.
- Deployment patterns that do not depend on a personal machine.

Twilio support in this repo is intentionally kept as an experimental adapter. It proves the core can receive webhook-based messages, but it is not production business-agent packaging yet.

## Boundary

Do not let business-agent concerns complicate the current profile router before the OpenClaw flow is stable. The current repo should remain easy to run locally and safe by default.
