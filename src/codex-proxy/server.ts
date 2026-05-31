import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pino } from 'pino';
import 'dotenv/config';
import { z } from 'zod';
import { runCodex, type CodexRunnerConfig } from './codex-runner.js';
import {
  buildPrompt,
  chatCompletionRequestSchema,
  type ToolPolicy,
  toChatCompletionResponse
} from './openai-types.js';

const logger = pino({ level: process.env.BOT_LOG_LEVEL ?? 'info' });

const configSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8787),
  apiKey: z.string().default('dev-local-change-me'),
  model: z.string().default('gpt-5.4'),
  timeoutMs: z.coerce.number().int().min(1000).default(120000),
  maxPromptChars: z.coerce.number().int().min(1000).default(20000),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('read-only'),
  allowWebSearch: z.coerce.boolean().default(true),
  workdir: z.string().default('.'),
  bin: z.string().default(process.platform === 'win32' ? 'codex.cmd' : 'codex'),
  transcriberProvider: z.enum(['off', 'openai', 'local-whisper', 'custom']).default('off'),
  transcriberBaseUrl: z.string().optional(),
  transcriberApiKey: z.string().optional(),
  transcriberTimeoutMs: z.coerce.number().int().min(1000).default(60000),
  mediaProvider: z.enum(['off', 'openai', 'custom', 'codex-cli']).default('off'),
  mediaBaseUrl: z.string().optional(),
  mediaApiKey: z.string().optional(),
  mediaTimeoutMs: z.coerce.number().int().min(1000).default(120000),
  mediaCodexModel: z.string().default('gpt-5.5'),
  mediaCodexSandbox: z.enum(['workspace-write', 'danger-full-access']).default('danger-full-access'),
  mediaOutputDir: z.string().default('./data/generated-media/codex-proxy'),
  localSpeechEngine: z.enum(['system', 'edge', 'piper']).default('system'),
  localSpeechVoice: z.string().optional(),
  localSpeechRate: z.coerce.number().int().min(-10).max(10).default(0),
  localTtsScript: z.string().default('./scripts/local-tts.py'),
  localTtsPython: z.string().default('python'),
  localTtsVoicesDir: z.string().optional(),
  localTtsRate: z.string().optional(),
  localTtsPitch: z.string().optional(),
  localTtsVolume: z.string().optional(),
  localTtsLengthScale: z.coerce.number().positive().optional()
});

const serverConfig = configSchema.parse({
  host: process.env.CODEX_PROXY_HOST,
  port: process.env.CODEX_PROXY_PORT,
  apiKey: process.env.CODEX_PROXY_API_KEY,
  model: process.env.CODEX_PROXY_MODEL,
  timeoutMs: process.env.CODEX_PROXY_TIMEOUT_MS,
  maxPromptChars: process.env.CODEX_PROXY_MAX_PROMPT_CHARS,
  sandbox: process.env.CODEX_PROXY_SANDBOX,
  allowWebSearch: process.env.CODEX_PROXY_ALLOW_WEB_SEARCH,
  workdir: process.env.CODEX_PROXY_WORKDIR,
  bin: process.env.CODEX_PROXY_CODEX_BIN,
  transcriberProvider: process.env.CODEX_PROXY_TRANSCRIBER_PROVIDER,
  transcriberBaseUrl: process.env.CODEX_PROXY_TRANSCRIBER_BASE_URL,
  transcriberApiKey: process.env.CODEX_PROXY_TRANSCRIBER_API_KEY ?? process.env.OPENAI_API_KEY,
  transcriberTimeoutMs: process.env.CODEX_PROXY_TRANSCRIBER_TIMEOUT_MS,
  mediaProvider: process.env.CODEX_PROXY_MEDIA_PROVIDER,
  mediaBaseUrl: process.env.CODEX_PROXY_MEDIA_BASE_URL,
  mediaApiKey: process.env.CODEX_PROXY_MEDIA_API_KEY ?? process.env.OPENAI_API_KEY,
  mediaTimeoutMs: process.env.CODEX_PROXY_MEDIA_TIMEOUT_MS,
  mediaCodexModel: process.env.CODEX_PROXY_MEDIA_CODEX_MODEL,
  mediaCodexSandbox: process.env.CODEX_PROXY_MEDIA_CODEX_SANDBOX,
  mediaOutputDir: process.env.CODEX_PROXY_MEDIA_OUTPUT_DIR,
  localSpeechEngine: process.env.CODEX_PROXY_LOCAL_SPEECH_ENGINE,
  localSpeechVoice: process.env.CODEX_PROXY_LOCAL_SPEECH_VOICE,
  localSpeechRate: process.env.CODEX_PROXY_LOCAL_SPEECH_RATE,
  localTtsScript: process.env.CODEX_PROXY_LOCAL_TTS_SCRIPT,
  localTtsPython: process.env.CODEX_PROXY_LOCAL_TTS_PYTHON,
  localTtsVoicesDir: process.env.CODEX_PROXY_LOCAL_TTS_VOICES_DIR,
  localTtsRate: process.env.CODEX_PROXY_LOCAL_TTS_RATE,
  localTtsPitch: process.env.CODEX_PROXY_LOCAL_TTS_PITCH,
  localTtsVolume: process.env.CODEX_PROXY_LOCAL_TTS_VOLUME,
  localTtsLengthScale: process.env.CODEX_PROXY_LOCAL_TTS_LENGTH_SCALE
});

const imageGenerationRequestSchema = z
  .object({
    model: z.string().optional(),
    prompt: z.string().min(1).max(12000),
    n: z.number().int().min(1).max(1).optional(),
    size: z.string().optional(),
    quality: z.string().optional(),
    output_format: z.enum(['png', 'jpeg', 'webp']).optional()
  })
  .passthrough();

const imageEditFieldsSchema = z
  .object({
    model: z.string().optional(),
    prompt: z.string().min(1).max(12000),
    n: z.string().optional(),
    size: z.string().optional(),
    quality: z.string().optional(),
    output_format: z.enum(['png', 'jpeg', 'webp']).optional()
  })
  .passthrough();

const speechRequestSchema = z
  .object({
    model: z.string().optional(),
    input: z.string().min(1).max(4000),
    voice: z.string().optional(),
    response_format: z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).optional()
  })
  .passthrough();

const runnerConfig: CodexRunnerConfig = {
  bin: serverConfig.bin,
  model: serverConfig.model,
  sandbox: serverConfig.sandbox,
  webSearch: false,
  timeoutMs: serverConfig.timeoutMs,
  workdir: path.resolve(serverConfig.workdir),
  maxPromptChars: serverConfig.maxPromptChars
};

let queue = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function sendJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

async function readRaw(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function isAuthorized(request: http.IncomingMessage): boolean {
  if (!serverConfig.apiKey) {
    return true;
  }

  return request.headers.authorization === `Bearer ${serverConfig.apiKey}`;
}

function headerEnabled(request: http.IncomingMessage, name: string): boolean {
  return request.headers[name.toLowerCase()]?.toString().toLowerCase() === 'true';
}

function transcriberBaseUrl(): string {
  if (serverConfig.transcriberBaseUrl) {
    return serverConfig.transcriberBaseUrl;
  }

  return serverConfig.transcriberProvider === 'local-whisper'
    ? 'http://127.0.0.1:2022/v1'
    : 'https://api.openai.com/v1';
}

function transcriberAuthHeader(): string | undefined {
  if (serverConfig.transcriberProvider === 'local-whisper') {
    return serverConfig.transcriberApiKey ? `Bearer ${serverConfig.transcriberApiKey}` : undefined;
  }

  return serverConfig.transcriberApiKey ? `Bearer ${serverConfig.transcriberApiKey}` : undefined;
}

function mediaBaseUrl(): string {
  return serverConfig.mediaBaseUrl ?? 'https://api.openai.com/v1';
}

function mediaAuthHeader(): string | undefined {
  return serverConfig.mediaApiKey ? `Bearer ${serverConfig.mediaApiKey}` : undefined;
}

function mediaConfigured(): boolean {
  if (serverConfig.mediaProvider === 'off') {
    return false;
  }

  if (serverConfig.mediaProvider === 'codex-cli') {
    return true;
  }

  if (serverConfig.mediaProvider === 'custom') {
    return Boolean(serverConfig.mediaBaseUrl);
  }

  return Boolean(serverConfig.mediaApiKey);
}

function mediaOutputDir(): string {
  return path.resolve(serverConfig.mediaOutputDir);
}

async function findExecutable(root: string, name: string): Promise<string | undefined> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = await findExecutable(fullPath, name);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

async function resolveFfmpeg(): Promise<string | undefined> {
  const explicit = process.env.CODEX_PROXY_FFMPEG_COMMAND ?? process.env.WHISPER_LOCAL_FFMPEG_COMMAND;
  if (explicit) {
    return path.resolve(explicit);
  }

  const installed = await findExecutable(
    path.resolve(process.env.WHISPER_LOCAL_DIR ?? path.join('data', 'whisper'), 'ffmpeg'),
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  );
  if (installed) {
    return installed;
  }

  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  const child = spawn(lookup, ['ffmpeg'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  await new Promise<void>((resolve) => child.on('close', () => resolve()));
  return stdout.split(/\r?\n/).find(Boolean)?.trim();
}

async function convertAudioToOpus(inputPath: string, outputPath: string): Promise<void> {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    throw new Error('ffmpeg executable not found for local speech opus conversion');
  }

  const child = spawn(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-af',
      'silenceremove=stop_periods=-1:stop_duration=0.35:stop_threshold=-45dB',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-vbr',
      'on',
      '-application',
      'voip',
      '-f',
      'ogg',
      outputPath
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => child.kill('SIGTERM'), serverConfig.mediaTimeoutMs);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffmpeg exited with status ${exitCode}`);
  }

  await fs.stat(outputPath);
}

async function convertAudioToWav(inputPath: string, outputPath: string): Promise<void> {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    throw new Error('ffmpeg executable not found for local speech wav conversion');
  }

  const child = spawn(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      outputPath
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => child.kill('SIGTERM'), serverConfig.mediaTimeoutMs);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffmpeg exited with status ${exitCode}`);
  }

  await fs.stat(outputPath);
}

const genericOpenAiSpeechVoices = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']);

function resolveLocalSpeechVoice(requestedVoice: string | undefined): string | undefined {
  if (serverConfig.localSpeechVoice?.trim()) {
    return serverConfig.localSpeechVoice.trim();
  }

  const normalizedRequested = requestedVoice?.trim();
  if (normalizedRequested && !genericOpenAiSpeechVoices.has(normalizedRequested.toLowerCase())) {
    return normalizedRequested;
  }

  if (serverConfig.localSpeechEngine === 'edge') {
    return 'pt-BR-FranciscaNeural';
  }

  if (serverConfig.localSpeechEngine === 'piper') {
    return 'pt_BR-jeff-medium';
  }

  return normalizedRequested;
}

function localSpeechSourceExtension(): 'mp3' | 'wav' {
  return serverConfig.localSpeechEngine === 'edge' ? 'mp3' : 'wav';
}

function generatedMediaPath(prefix: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(mediaOutputDir(), `${prefix}-${timestamp}-${cryptoRandomSuffix()}.${extension}`);
}

function cryptoRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function parseJsonBody(body: Buffer): unknown {
  return body.byteLength ? JSON.parse(body.toString('utf8')) : {};
}

type MultipartPart = {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
};

function parseHeaderParameters(value: string | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  if (!value) {
    return params;
  }

  for (const part of value.split(';').slice(1)) {
    const [rawKey, ...rawValue] = part.split('=');
    const key = rawKey?.trim().toLowerCase();
    if (!key) {
      continue;
    }

    const joinedValue = rawValue.join('=').trim();
    params[key] = joinedValue.replace(/^"|"$/g, '');
  }

  return params;
}

function parseMultipartBody(body: Buffer, contentType: string | undefined): MultipartPart[] {
  const boundaryMatch = contentType?.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundaryText = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundaryText) {
    throw new Error('multipart boundary missing');
  }

  const boundary = Buffer.from(`--${boundaryText}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(boundary);

  while (cursor >= 0) {
    cursor += boundary.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) {
      break;
    }
    if (body[cursor] === 13 && body[cursor + 1] === 10) {
      cursor += 2;
    }

    const headerEnd = body.indexOf(headerSeparator, cursor);
    if (headerEnd < 0) {
      break;
    }

    const nextBoundary = body.indexOf(boundary, headerEnd + headerSeparator.length);
    if (nextBoundary < 0) {
      break;
    }

    const headerLines = body
      .subarray(cursor, headerEnd)
      .toString('utf8')
      .split(/\r?\n/u);
    const headers: Record<string, string> = {};
    for (const line of headerLines) {
      const separator = line.indexOf(':');
      if (separator > 0) {
        headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
      }
    }

    const dispositionParams = parseHeaderParameters(headers['content-disposition']);
    let dataEnd = nextBoundary;
    if (dataEnd >= 2 && body[dataEnd - 2] === 13 && body[dataEnd - 1] === 10) {
      dataEnd -= 2;
    }

    if (dispositionParams.name) {
      parts.push({
        name: dispositionParams.name,
        filename: dispositionParams.filename,
        contentType: headers['content-type'],
        data: body.subarray(headerEnd + headerSeparator.length, dataEnd)
      });
    }

    cursor = nextBoundary;
  }

  return parts;
}

function multipartTextFields(parts: MultipartPart[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of parts) {
    if (!part.filename) {
      fields[part.name] = part.data.toString('utf8');
    }
  }
  return fields;
}

function imageExtensionFromPart(part: MultipartPart, index: number): string {
  const name = part.filename?.toLowerCase() ?? '';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'jpg';
  }
  if (name.endsWith('.webp')) {
    return 'webp';
  }
  if (name.endsWith('.gif')) {
    return 'gif';
  }
  if (part.contentType?.includes('jpeg')) {
    return 'jpg';
  }
  if (part.contentType?.includes('webp')) {
    return 'webp';
  }
  if (part.contentType?.includes('gif')) {
    return 'gif';
  }
  return index >= 0 ? 'png' : 'bin';
}

async function validatePng(filePath: string): Promise<void> {
  const file = await fs.readFile(filePath);
  const signature = file.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error('codex-cli image output is not a PNG');
  }
}

async function sendCodexImageFileResponse(
  response: http.ServerResponse,
  outputPath: string,
  result: { durationMs?: number } | undefined,
  warning?: string
): Promise<void> {
  await validatePng(outputPath);
  const image = await fs.readFile(outputPath);
  logger.info(
    {
      model: serverConfig.mediaCodexModel,
      durationMs: result?.durationMs,
      outputPath,
      bytes: image.byteLength,
      warning
    },
    warning ? 'codex-cli image generation finished with warning' : 'codex-cli image generation finished'
  );
  sendJson(response, 200, {
    created: Math.floor(Date.now() / 1000),
    data: [
      {
        b64_json: image.toString('base64')
      }
    ]
  });
}

function buildCodexImagePrompt(input: z.infer<typeof imageGenerationRequestSchema>, outputPath: string): string {
  return [
    'Use a ferramenta nativa real de geracao de imagens disponivel no Codex CLI.',
    'Gere exatamente uma imagem nova para o pedido abaixo.',
    `Pedido do usuario:\n${input.prompt}`,
    input.size ? `Tamanho desejado, se a ferramenta permitir: ${input.size}.` : undefined,
    input.quality ? `Qualidade desejada, se a ferramenta permitir: ${input.quality}.` : undefined,
    `Salve a imagem final exatamente neste caminho como PNG: ${outputPath}`,
    'Nao crie placeholder, SVG, HTML, canvas, gradiente simples, retangulo solido ou imagem programatica.',
    'Nao inclua texto, legenda, marca d agua, logo ou interface dentro da imagem, exceto se o pedido solicitar explicitamente.',
    'Depois de salvar, responda somente com o caminho do arquivo salvo.'
  ]
    .filter(Boolean)
    .join('\n');
}

async function generateCodexImageResponse(body: Buffer, response: http.ServerResponse): Promise<void> {
  const parsed = imageGenerationRequestSchema.parse(parseJsonBody(body));
  const outputFormat = parsed.output_format ?? 'png';
  if (outputFormat !== 'png') {
    sendJson(response, 400, {
      error: {
        message: 'codex-cli image generation currently supports output_format=png only',
        type: 'invalid_request_error'
      }
    });
    return;
  }

  await fs.mkdir(mediaOutputDir(), { recursive: true });
  const outputPath = generatedMediaPath('codex-image', 'png');
  const prompt = buildCodexImagePrompt(parsed, outputPath);
  let result: Awaited<ReturnType<typeof runCodex>> | undefined;
  try {
    result = await enqueue(() =>
      runCodex(prompt, {
        ...runnerConfig,
        model: serverConfig.mediaCodexModel,
        sandbox: serverConfig.mediaCodexSandbox,
        timeoutMs: serverConfig.mediaTimeoutMs,
        maxPromptChars: Math.max(runnerConfig.maxPromptChars, 20000)
      })
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await sendCodexImageFileResponse(response, outputPath, result, reason.slice(0, 500));
      return;
    } catch {
      throw error;
    }
  }

  await sendCodexImageFileResponse(response, outputPath, result);
}

function buildCodexImageEditPrompt(input: {
  fields: z.infer<typeof imageEditFieldsSchema>;
  imagePaths: string[];
  outputPath: string;
}): string {
  return [
    'Use a ferramenta nativa real de geracao/edicao de imagens disponivel no Codex CLI.',
    'Gere exatamente uma imagem final usando todas as imagens de referencia abaixo como base visual.',
    'As referencias podem representar a mesma pessoa, produto, objeto, estilo, design ou composicao. Preserve os elementos consistentes que forem relevantes ao pedido do usuario.',
    '',
    `Pedido do usuario:\n${input.fields.prompt}`,
    '',
    'Imagens de referencia locais:',
    ...input.imagePaths.map((imagePath, index) => `${index + 1}. ${imagePath}`),
    '',
    input.fields.size ? `Tamanho desejado, se a ferramenta permitir: ${input.fields.size}.` : undefined,
    input.fields.quality ? `Qualidade desejada, se a ferramenta permitir: ${input.fields.quality}.` : undefined,
    `Salve a imagem final exatamente neste caminho como PNG: ${input.outputPath}`,
    'Nao crie placeholder, SVG, HTML, canvas, gradiente simples, retangulo solido ou imagem programatica.',
    'Nao inclua texto, legenda, marca d agua, logo ou interface dentro da imagem, exceto se o pedido solicitar explicitamente.',
    'Depois de salvar, responda somente com o caminho do arquivo salvo.'
  ]
    .filter(Boolean)
    .join('\n');
}

async function generateCodexImageEditResponse(
  contentType: string | undefined,
  body: Buffer,
  response: http.ServerResponse
): Promise<void> {
  const parts = parseMultipartBody(body, contentType);
  const fields = imageEditFieldsSchema.parse(multipartTextFields(parts));
  const outputFormat = fields.output_format ?? 'png';
  if (outputFormat !== 'png') {
    sendJson(response, 400, {
      error: {
        message: 'codex-cli image edits currently support output_format=png only',
        type: 'invalid_request_error'
      }
    });
    return;
  }

  const imageParts = parts.filter(
    (part) => Boolean(part.filename) && (part.name === 'image' || part.name === 'image[]' || part.name.startsWith('image['))
  );
  if (!imageParts.length) {
    sendJson(response, 400, {
      error: {
        message: 'At least one image reference is required',
        type: 'invalid_request_error'
      }
    });
    return;
  }

  await fs.mkdir(mediaOutputDir(), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(mediaOutputDir(), 'codex-edit-input-'));
  const outputPath = generatedMediaPath('codex-image-edit', 'png');
  const imagePaths: string[] = [];

  try {
    for (const [index, part] of imageParts.entries()) {
      const imagePath = path.join(tempDir, `reference-${index + 1}.${imageExtensionFromPart(part, index)}`);
      await fs.writeFile(imagePath, part.data);
      imagePaths.push(imagePath);
    }

    const prompt = buildCodexImageEditPrompt({ fields, imagePaths, outputPath });
    let result: Awaited<ReturnType<typeof runCodex>> | undefined;
    try {
      result = await enqueue(() =>
        runCodex(prompt, {
          ...runnerConfig,
          model: serverConfig.mediaCodexModel,
          sandbox: serverConfig.mediaCodexSandbox,
          timeoutMs: serverConfig.mediaTimeoutMs,
          maxPromptChars: Math.max(runnerConfig.maxPromptChars, 24000)
        })
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await sendCodexImageFileResponse(response, outputPath, result, reason.slice(0, 500));
        return;
      } catch {
        throw error;
      }
    }

    await sendCodexImageFileResponse(response, outputPath, result);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function runSystemSpeech(inputPath: string, outputPath: string, voice: string | undefined): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('local speech generation is only implemented for Windows System.Speech');
  }

  const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-speech-script-'));
  const scriptPath = path.join(scriptDir, 'speak.ps1');
  const script = `
param(
  [string]$InputPath,
  [string]$OutputPath,
  [string]$Voice,
  [int]$Rate = 0
)
Add-Type -AssemblyName System.Speech
$text = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice -and $Voice -ne "default") {
  try { $synth.SelectVoice($Voice) } catch {}
}
$synth.Rate = $Rate
$synth.Volume = 100
$synth.SetOutputToWaveFile($OutputPath)
$synth.Speak($text)
$synth.Dispose()
`;

  try {
    await fs.writeFile(scriptPath, script, 'utf8');
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        inputPath,
        outputPath,
        voice ?? serverConfig.localSpeechVoice ?? '',
        String(serverConfig.localSpeechRate)
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => child.kill('SIGTERM'), serverConfig.mediaTimeoutMs);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    clearTimeout(timeout);

    if (exitCode !== 0) {
      throw new Error(stderr.trim() || `local speech exited with status ${exitCode}`);
    }

    await fs.stat(outputPath);
  } finally {
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
}

async function runPythonLocalTts(inputPath: string, outputPath: string, voice: string | undefined): Promise<void> {
  const engine = serverConfig.localSpeechEngine;
  if (engine !== 'edge' && engine !== 'piper') {
    throw new Error(`unsupported local TTS engine: ${engine}`);
  }

  const scriptPath = path.resolve(serverConfig.localTtsScript);
  const args = [
    scriptPath,
    'tts',
    '--text-file',
    inputPath,
    '--output',
    outputPath,
    '--engine',
    engine
  ];

  if (voice) {
    args.push('--voice', voice);
  }

  if (engine === 'edge') {
    if (serverConfig.localTtsRate) {
      args.push('--rate', serverConfig.localTtsRate);
    }
    if (serverConfig.localTtsPitch) {
      args.push('--pitch', serverConfig.localTtsPitch);
    }
    if (serverConfig.localTtsVolume) {
      args.push('--volume', serverConfig.localTtsVolume);
    }
  } else if (serverConfig.localTtsLengthScale !== undefined) {
    args.push('--length-scale', String(serverConfig.localTtsLengthScale));
  }

  if (serverConfig.localTtsVoicesDir) {
    args.push('--voices-dir', path.resolve(serverConfig.localTtsVoicesDir));
  }

  const child = spawn(serverConfig.localTtsPython, args, {
    cwd: path.dirname(scriptPath),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env
    }
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => child.kill('SIGTERM'), serverConfig.mediaTimeoutMs);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearTimeout(timeout);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `local TTS ${engine} exited with status ${exitCode}`);
  }

  await fs.stat(outputPath);
}

async function runLocalSpeech(inputPath: string, outputPath: string, requestedVoice: string | undefined): Promise<void> {
  const voice = resolveLocalSpeechVoice(requestedVoice);
  if (serverConfig.localSpeechEngine === 'system') {
    await runSystemSpeech(inputPath, outputPath, voice);
    return;
  }

  await runPythonLocalTts(inputPath, outputPath, voice);
}

async function generateLocalSpeechResponse(body: Buffer, response: http.ServerResponse): Promise<void> {
  const parsed = speechRequestSchema.parse(parseJsonBody(body));
  const responseFormat = parsed.response_format ?? 'wav';
  if (responseFormat !== 'wav' && responseFormat !== 'opus') {
    sendJson(response, 400, {
      error: {
        message: 'codex-cli local speech currently supports response_format=wav or opus',
        type: 'invalid_request_error'
      }
    });
    return;
  }

  await fs.mkdir(mediaOutputDir(), { recursive: true });
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-proxy-speech-'));
  const inputPath = path.join(runDir, 'input.txt');
  const sourceExtension = localSpeechSourceExtension();
  const shouldPostConvert = responseFormat === 'opus' || (responseFormat === 'wav' && sourceExtension !== 'wav');
  const sourcePath = path.join(runDir, `speech.${sourceExtension}`);
  const outputPath =
    responseFormat === 'opus'
      ? generatedMediaPath('local-speech', 'opus')
      : generatedMediaPath('local-speech', 'wav');
  try {
    await fs.writeFile(inputPath, parsed.input, 'utf8');
    await runLocalSpeech(inputPath, shouldPostConvert ? sourcePath : outputPath, parsed.voice);
    if (responseFormat === 'opus') {
      await convertAudioToOpus(sourcePath, outputPath);
    } else if (shouldPostConvert) {
      await convertAudioToWav(sourcePath, outputPath);
    }
    const audio = await fs.readFile(outputPath);
    logger.info({ outputPath, bytes: audio.byteLength, responseFormat }, 'local speech generation finished');
    response.writeHead(200, {
      'content-type': responseFormat === 'opus' ? 'audio/ogg; codecs=opus' : 'audio/wav',
      'content-length': audio.byteLength
    });
    response.end(audio);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
}

async function forwardAudioTranscription(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (serverConfig.transcriberProvider === 'off') {
    sendJson(response, 501, {
      error: {
        message: 'Audio transcription is disabled in codex-proxy',
        type: 'not_implemented'
      }
    });
    return;
  }

  if (serverConfig.transcriberProvider === 'openai' && !serverConfig.transcriberApiKey) {
    sendJson(response, 500, {
      error: {
        message: 'CODEX_PROXY_TRANSCRIBER_API_KEY or OPENAI_API_KEY is required for openai transcription',
        type: 'server_error'
      }
    });
    return;
  }

  const contentType = request.headers['content-type'];
  if (!contentType?.includes('multipart/form-data')) {
    sendJson(response, 400, {
      error: {
        message: 'Expected multipart/form-data',
        type: 'invalid_request_error'
      }
    });
    return;
  }

  const body = await readRaw(request);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), serverConfig.transcriberTimeoutMs);

  try {
    const upstreamUrl = `${transcriberBaseUrl().replace(/\/$/, '')}/audio/transcriptions`;
    const authHeader = transcriberAuthHeader();
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': contentType,
        ...(authHeader ? { authorization: authHeader } : {})
      },
      body
    });
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'content-length': upstreamBody.byteLength
    });
    response.end(upstreamBody);
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardMediaJsonRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstreamPath: '/images/generations' | '/audio/speech'
): Promise<void> {
  if (serverConfig.mediaProvider === 'off') {
    sendJson(response, 501, {
      error: {
        message: 'Image and speech generation are disabled in codex-proxy',
        type: 'not_implemented'
      }
    });
    return;
  }

  if (serverConfig.mediaProvider === 'openai' && !serverConfig.mediaApiKey) {
    sendJson(response, 500, {
      error: {
        message: 'CODEX_PROXY_MEDIA_API_KEY or OPENAI_API_KEY is required for openai media generation',
        type: 'server_error'
      }
    });
    return;
  }

  if (serverConfig.mediaProvider === 'custom' && !serverConfig.mediaBaseUrl) {
    sendJson(response, 500, {
      error: {
        message: 'CODEX_PROXY_MEDIA_BASE_URL is required for custom media generation',
        type: 'server_error'
      }
    });
    return;
  }

  const contentType = request.headers['content-type'] ?? 'application/json';
  if (!contentType.includes('application/json')) {
    sendJson(response, 400, {
      error: {
        message: 'Expected application/json',
        type: 'invalid_request_error'
      }
    });
    return;
  }

  const body = await readRaw(request);

  if (serverConfig.mediaProvider === 'codex-cli') {
    if (upstreamPath === '/images/generations') {
      await generateCodexImageResponse(body, response);
      return;
    }

    await generateLocalSpeechResponse(body, response);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), serverConfig.mediaTimeoutMs);

  try {
    const upstreamUrl = `${mediaBaseUrl().replace(/\/$/, '')}${upstreamPath}`;
    const authHeader = mediaAuthHeader();
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': contentType,
        ...(authHeader ? { authorization: authHeader } : {})
      },
      body
    });
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'content-length': upstreamBody.byteLength
    });
    response.end(upstreamBody);
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardMediaMultipartRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  upstreamPath: '/images/edits'
): Promise<void> {
  if (serverConfig.mediaProvider === 'off') {
    sendJson(response, 501, {
      error: {
        message: 'Image editing is disabled in codex-proxy',
        type: 'not_implemented'
      }
    });
    return;
  }

  if (serverConfig.mediaProvider === 'openai' && !serverConfig.mediaApiKey) {
    sendJson(response, 500, {
      error: {
        message: 'CODEX_PROXY_MEDIA_API_KEY or OPENAI_API_KEY is required for openai image editing',
        type: 'server_error'
      }
    });
    return;
  }

  if (serverConfig.mediaProvider === 'custom' && !serverConfig.mediaBaseUrl) {
    sendJson(response, 500, {
      error: {
        message: 'CODEX_PROXY_MEDIA_BASE_URL is required for custom image editing',
        type: 'server_error'
      }
    });
    return;
  }

  const contentType = request.headers['content-type'];
  if (!contentType?.includes('multipart/form-data')) {
    sendJson(response, 400, {
      error: {
        message: 'Expected multipart/form-data',
        type: 'invalid_request_error'
      }
    });
    return;
  }

  const body = await readRaw(request);

  if (serverConfig.mediaProvider === 'codex-cli') {
    await generateCodexImageEditResponse(contentType, body, response);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), serverConfig.mediaTimeoutMs);

  try {
    const upstreamUrl = `${mediaBaseUrl().replace(/\/$/, '')}${upstreamPath}`;
    const authHeader = mediaAuthHeader();
    const upstream = await fetch(upstreamUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': contentType,
        ...(authHeader ? { authorization: authHeader } : {})
      },
      body
    });
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'content-length': upstreamBody.byteLength
    });
    response.end(upstreamBody);
  } finally {
    clearTimeout(timeout);
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, {
        ok: true,
        model: serverConfig.model,
        sandbox: serverConfig.sandbox,
        allowWebSearch: serverConfig.allowWebSearch,
        transcriberProvider: serverConfig.transcriberProvider,
        transcriberBaseUrl: transcriberBaseUrl(),
        transcriberConfigured:
          serverConfig.transcriberProvider === 'local-whisper' ||
          Boolean(serverConfig.transcriberApiKey),
        mediaProvider: serverConfig.mediaProvider,
        mediaBaseUrl: mediaBaseUrl(),
        mediaConfigured: mediaConfigured(),
        mediaCodexModel: serverConfig.mediaCodexModel,
        mediaOutputDir: mediaOutputDir(),
        localSpeechEngine: serverConfig.localSpeechEngine
      });
      return;
    }

    if (!isAuthorized(request)) {
      sendJson(response, 401, {
        error: {
          message: 'Missing or invalid bearer token',
          type: 'authentication_error'
        }
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, {
        object: 'list',
        data: [
          {
            id: serverConfig.model,
            object: 'model',
            owned_by: 'codex-cli'
          }
        ]
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
      await forwardAudioTranscription(request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/images/generations') {
      await forwardMediaJsonRequest(request, response, '/images/generations');
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/images/edits') {
      await forwardMediaMultipartRequest(request, response, '/images/edits');
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/audio/speech') {
      await forwardMediaJsonRequest(request, response, '/audio/speech');
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const parsed = chatCompletionRequestSchema.parse(await readJson(request));
      if (parsed.stream) {
        sendJson(response, 400, {
          error: {
            message: 'Streaming is not implemented in the local Codex proxy yet',
            type: 'invalid_request_error'
          }
        });
        return;
      }

      const requestedTools: ToolPolicy = {
        webSearch: serverConfig.allowWebSearch && headerEnabled(request, 'x-codex-proxy-web-search'),
        localRead: headerEnabled(request, 'x-codex-proxy-local-read')
      };
      const prompt = buildPrompt(parsed, requestedTools);
      const model = parsed.model ?? serverConfig.model;
      const result = await enqueue(() => runCodex(prompt, { ...runnerConfig, model, webSearch: requestedTools.webSearch }));

      logger.info(
        {
          model,
          tools: requestedTools,
          durationMs: result.durationMs,
          stdoutBytes: Buffer.byteLength(result.stdout),
          stderrBytes: Buffer.byteLength(result.stderr)
        },
        'codex completion finished'
      );

      sendJson(response, 200, toChatCompletionResponse(model, result.content));
      return;
    }

    sendJson(response, 404, {
      error: {
        message: 'Not found',
        type: 'invalid_request_error'
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, 'codex proxy request failed');
    sendJson(response, 500, {
      error: {
        message,
        type: 'server_error'
      }
    });
  }
});

server.listen(serverConfig.port, serverConfig.host, () => {
  logger.info(
    {
      url: `http://${serverConfig.host}:${serverConfig.port}`,
      model: serverConfig.model,
      sandbox: serverConfig.sandbox,
      allowWebSearch: serverConfig.allowWebSearch,
      transcriberProvider: serverConfig.transcriberProvider,
      transcriberBaseUrl: transcriberBaseUrl(),
      mediaProvider: serverConfig.mediaProvider,
      mediaBaseUrl: mediaBaseUrl(),
      localSpeechEngine: serverConfig.localSpeechEngine,
      workdir: runnerConfig.workdir,
      bin: serverConfig.bin,
      authEnabled: Boolean(serverConfig.apiKey)
    },
    'Codex proxy listening'
  );
});
