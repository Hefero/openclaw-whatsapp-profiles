# Architecture

## Runtime Flow

```text
WhatsApp
  -> OpenClaw gateway
  -> whatsapp-policy-dispatch plugin
  -> openclaw-worker HTTP bridge
  -> target policy
  -> guidance profile
  -> configured OpenAI-compatible responder endpoint
  -> delivery gate
  -> OpenClaw WhatsApp send
```

## Components

- OpenClaw gateway: owns WhatsApp pairing, inbound events, and message delivery.
- `whatsapp-policy-dispatch`: OpenClaw plugin that intercepts WhatsApp inbound messages before native agent dispatch.
- `openclaw-worker`: HTTP worker that normalizes inbound payloads, resolves target policy, calls the responder, and returns reply/draft/block decisions.
- responder provider: direct OpenAI-compatible API by default, or optional `codex-proxy` backed by `codex exec`.
- `openclaw-control`: local HTTP endpoint for manual test sends.
- optional `whisper-local`: local `whisper.cpp` transcription server for profile-enabled voice notes.
- `bot-policy.local.json`: private local policy file with profiles, targets, allowlists, quiet hours, and auto-reply settings.

## Safety Defaults

- The default mode is `observe`.
- Local policy is not committed.
- Message/runtime state is stored under `data/`, which is ignored by git.
- Auto-reply requires explicit global and per-target approval.
- Group intake is open in the example policy, but defaults stay observe-only. Group draft/auto behavior still requires explicit policy changes, and auto-send remains gated.
- Local proxy processes bind to localhost by default.
