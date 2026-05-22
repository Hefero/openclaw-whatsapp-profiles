# Voice Notes

Voice-note support is profile-gated. Unknown/default chats do not transcribe audio unless their selected profile sets `voice.enabled=true`.

## Flow

```text
WhatsApp voice note
  -> OpenClaw WhatsApp plugin
  -> whatsapp-policy-dispatch reply_dispatch
  -> openclaw-worker
  -> codex-proxy /v1/audio/transcriptions
  -> local whisper.cpp or OpenAI transcription
  -> normal guidance/responder flow
```

`codex exec` is still used only for text reasoning. Audio is transcribed before the responder sees the message.

## Local Whisper Setup

Use this path to avoid a transcription API key:

```text
CODEX_PROXY_TRANSCRIBER_PROVIDER=local-whisper
CODEX_PROXY_TRANSCRIBER_BASE_URL=http://127.0.0.1:2022/v1
CODEX_PROXY_TRANSCRIBER_MODEL=base
TRANSCRIBER_BASE_URL=http://127.0.0.1:8787/v1
TRANSCRIBER_API_KEY=dev-local-change-me
TRANSCRIBER_MODEL=base
WHISPER_LOCAL_ENABLED=true
WHISPER_LOCAL_MODEL=base
WHISPER_LOCAL_PORT=2022
```

Then run:

```bash
npm run warmup:whisper
npm run warmup
npm run warmup:status
```

On Windows, `warmup:whisper` downloads under `data/whisper/`:

- `whisper.cpp` portable release
- `ggml-base.bin`
- portable FFmpeg

Those files are runtime artifacts and are ignored by Git.

## Profile Config

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

Set `voice.language` per profile when you know the expected language. This avoids auto-detection mistakes. `pt`, `en`, and `es` are typical values.

## Test

The full stack should show five healthy services when local Whisper is enabled:

```bash
npm run warmup:status
```

Expected services:

- `whisper-local`
- `codex-proxy`
- `openclaw-gateway`
- `openclaw-control`
- `openclaw-worker`

Real WhatsApp test:

1. Enable `voice.enabled=true` on the target profile.
2. Make sure the target is in `auto` or `draft`.
3. Send a short voice note to that contact/group.
4. Check `data/runtime/openclaw-worker.log` for `inputKind":"voice"` and `openclaw inbound message normalized`.

Direct proxy smoke test:

```bash
curl.exe -s -X POST http://127.0.0.1:8787/v1/audio/transcriptions ^
  -H "Authorization: Bearer dev-local-change-me" ^
  -F "file=@data/runtime/voice-smoke.wav" ^
  -F "model=base" ^
  -F "language=pt"
```

The direct test requires an existing local audio file.

## Quality And Models

`base` is the default because it is small and practical for a local machine. It can make transcription mistakes, especially with noisy WhatsApp audio. If accuracy is not good enough, try:

```text
WHISPER_LOCAL_MODEL=small
TRANSCRIBER_MODEL=small
CODEX_PROXY_TRANSCRIBER_MODEL=small
```

Then rerun:

```bash
npm run warmup:whisper
npm run warmup
```

`small` is slower and downloads a larger model.

## Troubleshooting

- If `whisper-local` is unhealthy, check `data/runtime/whisper-local.log`.
- If the log says FFmpeg is missing, rerun `npm run warmup:whisper`; on Windows the script downloads a portable FFmpeg.
- If the worker says `voice disabled for profile`, enable `voice.enabled=true` on the active profile.
- If the worker says `transcriber api key missing`, confirm `TRANSCRIBER_BASE_URL` points to `http://127.0.0.1:8787/v1` and `TRANSCRIBER_API_KEY` matches `CODEX_PROXY_API_KEY`.
- If transcription works but replies are low quality, tune the guidance profile first; the responder only sees the transcript, not the audio.
