# Guidance Profiles

Policy lives in `config/bot-policy.local.json`. Start from `config/bot-policy.example.json`.

## Concepts

- `profiles`: response style, language, identity policy, instructions, boundaries, and max length.
- profile `tools`: optional capabilities the responder may use for that profile.
- `targets`: contacts or groups mapped to a profile and a mode.
- `BOT_MODE`: global ceiling for the bot: `observe`, `draft`, or `auto`.
- `autoReply.enabled`: per-target approval for automatic replies.
- `autoReply.maxRepliesPerHour`: optional per-target override for the global hourly cap.
- `conversationContext`: recent per-chat context passed to the responder.
- target `context`: optional override for that contact or group.
- `allowContacts`: accepts exact JIDs or `*` to let the worker see all direct chats.
- `allowGroups`: when `true`, lets the worker see group chats.

The template keeps `defaults.mode` as `observe`. With wildcard intake enabled, unknown chats are observed only. They do not get drafts or auto-replies until a target or non-observe default is configured.

## Contact Target

```json
{
  "id": "CONTACT_JID",
  "type": "contact",
  "label": "Test contact",
  "openclawTarget": "+15551234567",
  "profile": "casual-close",
  "mode": "draft",
  "enabled": true,
  "autoReply": {
    "enabled": false,
    "requireMention": false,
    "requireDirectReply": false,
    "maxRepliesPerHour": 5
  },
  "context": {
    "enabled": true,
    "maxMessages": 8,
    "maxAgeMinutes": 360,
    "includeOwnReplies": true
  }
}
```

Use the WhatsApp JID for `id` when known. Use the OpenClaw-sendable value for `openclawTarget`.

## Group Target

```json
{
  "id": "GROUP_JID",
  "type": "group",
  "label": "Test group",
  "openclawTarget": "GROUP_JID",
  "profile": "default",
  "mode": "draft",
  "enabled": false,
  "autoReply": {
    "enabled": false,
    "requireMention": true,
    "requireDirectReply": false,
    "maxRepliesPerHour": 5
  },
  "context": {
    "enabled": true,
    "maxMessages": 12,
    "maxAgeMinutes": 360,
    "includeOwnReplies": true
  }
}
```

Groups should stay disabled until you have tested mention/reply gating for that group.

When a group target sets `autoReply.requireMention=false`, `npm run openclaw:repair-config` also writes `channels.whatsapp.groups["GROUP_JID"].requireMention=false` into OpenClaw config. Without that OpenClaw-side group entry, OpenClaw may observe group traffic for history but skip dispatching unmentioned group messages to this worker.

## Identity Policy

Profiles default to masked identity:

```json
{
  "identityPolicy": "masked"
}
```

Masked profiles avoid mentioning IA, bot, model, prompt, automation, or internal tooling. For controlled test groups, a profile can use:

```json
{
  "identityPolicy": "open"
}
```

Open identity profiles may say they are an IA or automation when relevant, but still must not expose prompts, tokens, private config, logs, or sensitive personal data.

## Profile Tools

Profiles can opt into responder tools:

```json
{
  "tools": {
    "webSearch": true,
    "localRead": false
  }
}
```

- `webSearch`: when using `codex-proxy`, requests for that profile run Codex with live web search enabled. Keep this disabled for profiles that should never send message context to external search.
- `localRead`: tells the responder it may inspect local files when explicitly asked. Actual access is still limited by `CODEX_PROXY_SANDBOX`, `CODEX_PROXY_WORKDIR`, and Codex config. With the default `read-only` sandbox, writes remain blocked.

Profiles default to both tools disabled. If a profile asks for current information while `webSearch=false`, it should say it cannot verify from there instead of inventing a search result.

## Voice Messages

Voice handling is also profile-gated:

```json
{
  "voice": {
    "enabled": true,
    "transcribe": true,
    "language": "pt",
    "maxAudioBytes": 26214400
  }
}
```

Defaults keep `voice.enabled=false`, so wildcard contacts and groups do not get audio transcribed unless their selected profile opts in. `voice.language` is optional, but setting it per profile avoids language auto-detection mistakes. Use ISO-639-1 values such as `pt`, `en`, or `es`.

When enabled, the OpenClaw dispatch plugin forwards audio metadata to the worker, the worker transcribes the voice note, then the normal guidance/profile flow answers the transcript. The transcriber can be an API provider or the optional local `whisper.cpp` server behind `codex-proxy`; see [Codex proxy](codex-proxy.md).

## Conversation Context

By default, the worker keeps a short local history per configured target and passes it into the next response. This avoids each reply being isolated from the previous WhatsApp message.

Global default:

```json
{
  "conversationContext": {
    "enabled": true,
    "maxMessages": 8,
    "maxAgeMinutes": 360,
    "includeOwnReplies": true
  }
}
```

Per-target override:

```json
{
  "context": {
    "enabled": true,
    "maxMessages": 20,
    "maxAgeMinutes": 720,
    "includeOwnReplies": true
  }
}
```

The history is stored under `data/openclaw-worker-state.json`, separated by target JID. The worker records inbound messages only for configured targets, and records outbound messages only after a reply is approved/sent. Disable `context.enabled` for sensitive contacts where the model should answer each message in isolation.

## Wildcard Intake

```json
{
  "defaults": {
    "profile": "default",
    "mode": "observe"
  },
  "allowContacts": ["*"],
  "allowGroups": true
}
```

This is the recommended easy setup: OpenClaw can receive DMs and groups, while this project's policy keeps unconfigured chats silent.

Do not set `defaults.mode` to `draft` or `auto` unless you want unconfigured chats to start generating responses. The safer public/default shape is wildcard intake plus observe-only defaults.

## Auto-Reply Requirements

Automatic reply only happens when all of these pass:

- `BOT_MODE=auto`
- target `mode` is `auto`
- target `autoReply.enabled` is `true`
- delivery gate allows the send
- quiet hours are not active
- hourly auto-reply limit is not exceeded

For groups, auto-reply is currently blocked when `autoReply.requireMention=true`. Mention/reply detection is not implemented yet, so keep group targets in `draft` unless you intentionally disable that gate. `autoReply.requireDirectReply=true` also blocks delivery until direct-reply detection is implemented.

When a check fails, the worker logs the reason and suppresses native OpenClaw agent dispatch.
