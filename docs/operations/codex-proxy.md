# Responder Provider

The worker calls an OpenAI-compatible `/chat/completions` endpoint configured by `RESPONDER_BASE_URL`, `RESPONDER_API_KEY`, and `RESPONDER_MODEL`.

The public/default setup is direct API key mode. `codex-proxy` is optional for users who want to back replies with a local Codex CLI session, run local Whisper transcription, or keep image and speech generation behind one local OpenAI-compatible endpoint.

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/audio/transcriptions`
- `POST /v1/images/generations`
- `POST /v1/audio/speech`

Streaming is not implemented. Transcription endpoints are provider pass-through. Image and speech endpoints are provider pass-through in `openai` and `custom` media modes; in `codex-cli` media mode, image generation runs an ephemeral Codex CLI request and speech generation uses a local TTS backend.

## Direct API Mode

Default public setup:

```text
CODEX_PROXY_ENABLED=false
RESPONDER_BASE_URL=https://api.openai.com/v1
RESPONDER_API_KEY=your-api-key
RESPONDER_MODEL=gpt-4o-mini
RESPONDER_TIMEOUT_MS=60000
```

This path does not require Codex CLI or a ChatGPT/Codex subscription. It consumes API credits from the configured provider and sends message context to that provider. Keep the API key only in `.env` or the host secret manager.

## Optional Codex Proxy

`codex-proxy` exposes the local Codex CLI as a small OpenAI-compatible Chat Completions endpoint.

```bash
npm run codex-proxy
npm run codex-proxy:test
```

The full project stack starts it automatically only when:

```text
CODEX_PROXY_ENABLED=true
```

Local Codex CLI proxy config:

```text
CODEX_PROXY_ENABLED=true
CODEX_PROXY_HOST=127.0.0.1
CODEX_PROXY_PORT=8787
CODEX_PROXY_API_KEY=dev-local-change-me
CODEX_PROXY_MODEL=gpt-5.4
CODEX_PROXY_TIMEOUT_MS=120000
CODEX_PROXY_MAX_PROMPT_CHARS=20000
CODEX_PROXY_SANDBOX=read-only
CODEX_PROXY_ALLOW_WEB_SEARCH=true
CODEX_PROXY_WORKDIR=.
CODEX_PROXY_CODEX_BIN=codex.cmd
CODEX_PROXY_TRANSCRIBER_PROVIDER=off
CODEX_PROXY_MEDIA_PROVIDER=off
```

Point the responder at the proxy:

```text
RESPONDER_BASE_URL=http://127.0.0.1:8787/v1
RESPONDER_API_KEY=dev-local-change-me
RESPONDER_MODEL=gpt-5.4
RESPONDER_TIMEOUT_MS=120000
```

Keep `WHATSAPP_ASSISTANT_DISPATCH_TIMEOUT_MS` at least as high as the responder timeout. The OpenClaw dispatch hook is synchronous; if the hook times out first, the worker may finish a valid reply that OpenClaw no longer delivers.

## Voice Transcription

`codex-proxy` can also expose an OpenAI-compatible `/v1/audio/transcriptions` endpoint. It does not use `codex exec` for audio; it forwards the multipart transcription request to a configured transcription backend.

Local Whisper path:

```text
CODEX_PROXY_ENABLED=true
CODEX_PROXY_TRANSCRIBER_PROVIDER=local-whisper
CODEX_PROXY_TRANSCRIBER_BASE_URL=http://127.0.0.1:2022/v1
CODEX_PROXY_TRANSCRIBER_MODEL=base
WHISPER_LOCAL_ENABLED=true
WHISPER_LOCAL_MODEL=base
TRANSCRIBER_BASE_URL=http://127.0.0.1:8787/v1
TRANSCRIBER_API_KEY=dev-local-change-me
TRANSCRIBER_MODEL=base
TRANSCRIBER_TIMEOUT_MS=60000
```

Run:

```bash
npm run warmup:whisper
npm run warmup
```

On Windows, `warmup:whisper` downloads a portable `whisper.cpp` release, the `base` model, and a portable FFmpeg build under `data/whisper/`. Nothing from that directory should be committed.

See [Voice notes](voice-notes.md) for the full operational test path and troubleshooting.

OpenAI transcription path:

```text
CODEX_PROXY_ENABLED=true
CODEX_PROXY_TRANSCRIBER_PROVIDER=openai
CODEX_PROXY_TRANSCRIBER_API_KEY=your-transcriber-api-key
CODEX_PROXY_TRANSCRIBER_MODEL=gpt-4o-mini-transcribe
TRANSCRIBER_BASE_URL=http://127.0.0.1:8787/v1
TRANSCRIBER_API_KEY=dev-local-change-me
TRANSCRIBER_MODEL=gpt-4o-mini-transcribe
```

When `CODEX_PROXY_ENABLED=false`, the worker can bypass `codex-proxy` and call the configured `TRANSCRIBER_BASE_URL` directly. In that mode it reuses `RESPONDER_API_KEY` for transcription unless `TRANSCRIBER_API_KEY` is set.

## Image And Speech Generation

`codex-proxy` can expose OpenAI-compatible `/v1/images/generations` and `/v1/audio/speech` endpoints. In `openai` or `custom` mode, these endpoints forward JSON requests to the configured media provider and return the provider response to the worker.

```text
CODEX_PROXY_ENABLED=true
CODEX_PROXY_MEDIA_PROVIDER=openai
CODEX_PROXY_MEDIA_API_KEY=your-openai-api-key
CODEX_PROXY_MEDIA_BASE_URL=https://api.openai.com/v1
CODEX_PROXY_MEDIA_TIMEOUT_MS=120000
```

When `CODEX_PROXY_ENABLED=true` and `CODEX_PROXY_MEDIA_PROVIDER` is not `off`, the worker defaults `IMAGE_GENERATOR_BASE_URL` and `SPEECH_BASE_URL` to `http://127.0.0.1:8787/v1` unless those variables are set explicitly. The worker authenticates to the local proxy with `CODEX_PROXY_API_KEY`; the proxy authenticates upstream with `CODEX_PROXY_MEDIA_API_KEY` or `OPENAI_API_KEY`.

If `CODEX_PROXY_ENABLED=false`, the worker can still call the configured `IMAGE_GENERATOR_BASE_URL` and `SPEECH_BASE_URL` directly. In direct mode, media generation reuses `OPENAI_API_KEY` or `RESPONDER_API_KEY` unless `IMAGE_GENERATOR_API_KEY` or `SPEECH_API_KEY` is set.

Local Codex image generation plus local TTS path:

```text
CODEX_PROXY_ENABLED=true
CODEX_PROXY_MEDIA_PROVIDER=codex-cli
CODEX_PROXY_MEDIA_CODEX_MODEL=gpt-5.5
CODEX_PROXY_MEDIA_CODEX_SANDBOX=danger-full-access
CODEX_PROXY_MEDIA_OUTPUT_DIR=./data/generated-media/codex-proxy
CODEX_PROXY_FFMPEG_COMMAND=./data/whisper/ffmpeg/ffmpeg-8.1.1-essentials_build/bin/ffmpeg.exe
CODEX_PROXY_MEDIA_TIMEOUT_MS=300000
WHATSAPP_ASSISTANT_DISPATCH_TIMEOUT_MS=300000
IMAGE_GENERATOR_MODEL=gpt-5.5
IMAGE_GENERATOR_OUTPUT_FORMAT=png
IMAGE_GENERATOR_TIMEOUT_MS=300000
SPEECH_MODEL=local-system-tts
SPEECH_RESPONSE_FORMAT=opus
OPENCLAW_COMMAND_TIMEOUT_MS=120000
```

In `codex-cli` media mode, `/v1/images/generations` runs an ephemeral Codex CLI request and returns an OpenAI-compatible `b64_json` image response. Keep the worker, proxy media, and dispatch timeouts aligned because image generation can take around two minutes. `/v1/audio/speech` supports `response_format=wav` or `response_format=opus`; use Opus for WhatsApp so the channel can send an Ogg/Opus voice file without doing its own FFmpeg transcode.

Local speech defaults to Windows `System.Speech`. For better voices, use the repo-local `scripts/local-tts.py` adapter:

```text
CODEX_PROXY_LOCAL_SPEECH_ENGINE=edge
CODEX_PROXY_LOCAL_SPEECH_VOICE=pt-BR-FranciscaNeural
CODEX_PROXY_LOCAL_TTS_SCRIPT=./scripts/local-tts.py
CODEX_PROXY_LOCAL_TTS_PYTHON=python
SPEECH_MODEL=local-tts
SPEECH_VOICE=pt-BR-FranciscaNeural
SPEECH_RESPONSE_FORMAT=opus
```

Install the optional Python packages with `npm run tts:install`. The Edge backend needs `edge-tts`. The Piper backend needs `piper-tts` and local voice files. Use `CODEX_PROXY_LOCAL_SPEECH_ENGINE=piper`, `CODEX_PROXY_LOCAL_SPEECH_VOICE=pt_BR-jeff-medium`, and `CODEX_PROXY_LOCAL_TTS_VOICES_DIR=./voices` for fully local Piper output.

## Inbound Image Understanding

Inbound WhatsApp image understanding is profile-gated with `tools.imageUnderstanding=true`. It is separate from image generation: before the responder runs, the worker reads the inbound image, extracts OCR/visual context, and passes that extracted context into the normal reply prompt.

Direct API mode:

```text
IMAGE_UNDERSTANDING_PROVIDER=openai
IMAGE_UNDERSTANDING_BASE_URL=https://api.openai.com/v1
IMAGE_UNDERSTANDING_API_KEY=your-openai-api-key
IMAGE_UNDERSTANDING_MODEL=gpt-4o-mini
IMAGE_UNDERSTANDING_TIMEOUT_MS=120000
```

Local Codex CLI mode reads OpenClaw's local `mediaPath` directly. When `CODEX_PROXY_ENABLED=true` and `CODEX_PROXY_MEDIA_PROVIDER=codex-cli`, this is the default unless `IMAGE_UNDERSTANDING_PROVIDER` overrides it:

```text
IMAGE_UNDERSTANDING_PROVIDER=codex-cli
IMAGE_UNDERSTANDING_CODEX_SANDBOX=danger-full-access
IMAGE_UNDERSTANDING_MODEL=gpt-5.5
```

## Stickers

Sticker requests are profile-gated with `tools.stickerGeneration=true`. The worker routes sticker intent before normal image intent, uses the configured image provider, and then converts the generated source image into a native WhatsApp sticker.

The sticker prompt asks the image provider for a flat `#00ff00` chroma-key background. Conversion removes that chroma key with FFmpeg, cleans low-alpha pixels with Pillow, and saves a 512x512 lossless WebP with exact alpha so WhatsApp clients do not show chroma-key color in transparent areas.

Required pieces:

```text
MEDIA_FFMPEG_COMMAND=./data/whisper/ffmpeg/ffmpeg-8.1.1-essentials_build/bin/ffmpeg.exe
MEDIA_STICKER_PYTHON=python
STICKER_SIZE=512
STICKER_QUALITY=65
STICKER_TIMEOUT_MS=60000
```

Run `npm run media:install` once for the Pillow dependency used to clean transparent pixels and write exact-alpha sticker WebP files. `npm run warmup` reapplies the local OpenClaw WhatsApp plugin patch that adds `asSticker=true` support to the `upload-file` gateway action. Sticker files are staged into OpenClaw's configured workspace before the gateway call so local media access rules allow the upload.

## Guardrails

For the local Codex proxy:

- Binds to `127.0.0.1` by default.
- Requires a bearer token.
- Serializes requests.
- Runs `codex exec --ephemeral`.
- Uses read-only sandbox by default.
- Enables Codex `--search` only when both `CODEX_PROXY_ALLOW_WEB_SEARCH=true` and the active guidance profile has `tools.webSearch=true`.
- Keeps transcription calls as explicit provider pass-throughs. Media calls are explicit too: `openai` and `custom` modes pass through to the configured provider, while `codex-cli` image generation intentionally runs an ephemeral Codex CLI request and local speech intentionally runs the configured local TTS backend.

`tools.localRead=true` is a profile-level permission for local inspection, not a global filesystem unlock. Actual file access is still constrained by Codex sandbox/config. Keep `CODEX_PROXY_SANDBOX=read-only` unless you intentionally want the responder to write files.

Do not expose this endpoint to the public internet.
