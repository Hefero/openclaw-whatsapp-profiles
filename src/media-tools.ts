import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './config.js';

type ImageGenerationResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
};

export type GeneratedMedia = {
  path: string;
};

export type MediaGenerationResult =
  | { ok: true; media: GeneratedMedia }
  | { ok: false; reason: string };

function normalizeIntentText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isLikelyImageGenerationRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized || normalized.length > 500) {
    return false;
  }

  return [
    /\b(cri|cria|crie|criar|gera|gere|gerar|faz|faca|desenha|desenhe|renderiza|renderize)\b.*\b(imagem|foto|figura|ilustracao|paisagem|avatar|wallpaper|desenho)\b/u,
    /\b(imagem|foto|figura|ilustracao|paisagem|avatar|wallpaper|desenho)\b.*\b(cri|cria|crie|criar|gera|gere|gerar|faz|faca|desenha|desenhe|manda|mande|mandi)\b/u
  ].some((pattern) => pattern.test(normalized));
}

export function isLikelyStickerGenerationRequest(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized || normalized.length > 500) {
    return false;
  }

  return [
    /\b(cri|cria|crie|criar|gera|gere|gerar|faz|faca|manda|mande|envia|envie|transforma|transforme)\b.*\b(figurinha|figurinhas|sticker|stickers|adesivo|adesivos)\b/u,
    /\b(figurinha|figurinhas|sticker|stickers|adesivo|adesivos)\b.*\b(cri|cria|crie|criar|gera|gere|gerar|faz|faca|manda|mande|envia|envie|transforma|transforme)\b/u
  ].some((pattern) => pattern.test(normalized));
}

export function isAudioReplyRequested(text: string): boolean {
  const normalized = normalizeIntentText(text);
  if (!normalized || normalized.length > 500) {
    return false;
  }

  return [
    /\b(responde|responda|manda|mande|fala|fale|envia|envie)\b.*\b(audio|voz|voice|nota de voz)\b/u,
    /\b(audio|voz|voice|nota de voz)\b.*\b(resposta|responde|responda|manda|mande|envia|envie)\b/u,
    /\bem audio\b/u
  ].some((pattern) => pattern.test(normalized));
}

export function imagePromptFromMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return 'Uma paisagem bonita, natural e bem iluminada.';
  }

  return [
    trimmed,
    'Crie uma imagem unica, visualmente clara e adequada para enviar em WhatsApp.',
    'Nao inclua texto, legenda, marca d agua ou interface dentro da imagem, a menos que o pedido solicite explicitamente.'
  ].join('\n');
}

function softenProtectedFranchiseReferences(text: string): string {
  return text.replace(
    /\bstar\s+wars\b/giu,
    'uma space opera original com naves, planetas deserticos, luas duplas, robos retrofuturistas e aventura galactica, sem personagens, logos ou nomes de franquias'
  );
}

export function stickerPromptFromMessage(text: string): string {
  const trimmed = text.trim();
  const subject = softenProtectedFranchiseReferences(trimmed) || 'Uma figurinha divertida e simples para WhatsApp.';

  return [
    subject,
    'Crie uma imagem pensada para virar figurinha de WhatsApp: composicao quadrada, um assunto principal grande, claro e legivel em 512x512.',
    'Use fundo verde chroma-key perfeitamente plano #00ff00, sem sombras, gradientes ou textura. Nao use verde no assunto principal.',
    'Use alto contraste e contorno ou sombra suave no assunto principal para funcionar bem em tema claro e escuro depois que o fundo for removido.',
    'Nao inclua texto, legenda, marca d agua ou interface dentro da imagem, a menos que o pedido solicite explicitamente.'
  ].join('\n');
}

export function speechTextFromReply(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/gu, (block) => block.replace(/`/gu, ' ').replace(/\s+/gu, ' '))
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gmu, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gmu, '')
    .replace(/[ \t]{2,}(?=\n)/gu, '')
    .replace(/[*_~]/gu, '')
    .replace(/\n+/gu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();

  return normalized || text.trim();
}

function extensionForImageFormat(format: AppConfig['imageGenerator']['outputFormat']): string {
  return format === 'jpeg' ? 'jpg' : format;
}

function mediaPath(outputDir: string, prefix: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(outputDir, `${prefix}-${timestamp}-${crypto.randomUUID()}.${extension}`);
}

async function errorText(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return `${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ''}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function runFileWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let failedToStart = false;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failedToStart = true;
      stderr += error.message;
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      if (timedOut) {
        stderr += `${stderr ? '\n' : ''}command timed out after ${timeoutMs}ms`;
      }
      resolve({
        status: failedToStart || timedOut ? 1 : status ?? 1,
        stdout,
        stderr
      });
    });
  });
}

export async function generateImageFile(input: {
  prompt: string;
  config: AppConfig['imageGenerator'];
  outputDir: string;
}): Promise<MediaGenerationResult> {
  if (!input.config.apiKey) {
    return { ok: false, reason: 'image generator API key not configured' };
  }

  try {
    await fs.mkdir(input.outputDir, { recursive: true });
    const response = await fetchWithTimeout(
      `${input.config.baseUrl.replace(/\/$/, '')}/images/generations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.config.apiKey}`
        },
        body: JSON.stringify({
          model: input.config.model,
          prompt: input.prompt,
          n: 1,
          size: input.config.size,
          quality: input.config.quality,
          output_format: input.config.outputFormat
        })
      },
      input.config.timeoutMs
    );

    if (!response.ok) {
      return { ok: false, reason: `image generation failed (${await errorText(response)})` };
    }

    const data = (await response.json()) as ImageGenerationResponse;
    const image = data.data?.[0];
    const extension = extensionForImageFormat(input.config.outputFormat);
    const outputPath = mediaPath(input.outputDir, 'image', extension);
    if (image?.b64_json) {
      await fs.writeFile(outputPath, Buffer.from(image.b64_json, 'base64'));
      return { ok: true, media: { path: outputPath } };
    }

    if (image?.url) {
      const imageResponse = await fetchWithTimeout(image.url, { method: 'GET' }, input.config.timeoutMs);
      if (!imageResponse.ok) {
        return { ok: false, reason: `image download failed (${await errorText(imageResponse)})` };
      }
      await fs.writeFile(outputPath, Buffer.from(await imageResponse.arrayBuffer()));
      return { ok: true, media: { path: outputPath } };
    }

    return { ok: false, reason: 'image generation returned no image data' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function convertImageToStickerFile(input: {
  imagePath: string;
  outputDir: string;
  ffmpegCommand?: string;
  size: number;
  quality: number;
  timeoutMs: number;
}): Promise<MediaGenerationResult> {
  if (!input.ffmpegCommand) {
    return { ok: false, reason: 'ffmpeg command not configured for sticker conversion' };
  }

  try {
    await fs.mkdir(input.outputDir, { recursive: true });
    const size = Math.max(64, Math.min(1024, Math.round(input.size)));
    const quality = Math.max(1, Math.min(100, Math.round(input.quality)));
    const outputPath = mediaPath(input.outputDir, 'sticker', 'webp');
    const filter = [
      'format=rgba',
      'colorkey=0x00ff00:0.30:0.06',
      'colorkey=0xffffff:0.11:0.04',
      `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
      `pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      'format=rgba'
    ].join(',');
    const result = await runFileWithTimeout(
      input.ffmpegCommand,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        input.imagePath,
        '-vf',
        filter,
        '-an',
        '-c:v',
        'libwebp',
        '-lossless',
        '0',
        '-q:v',
        String(quality),
        '-compression_level',
        '6',
        '-preset',
        'picture',
        outputPath
      ],
      input.timeoutMs
    );

    if (result.status !== 0) {
      return { ok: false, reason: result.stderr || result.stdout || `ffmpeg exited with status ${result.status}` };
    }

    return { ok: true, media: { path: outputPath } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function synthesizeSpeechFile(input: {
  text: string;
  config: AppConfig['speech'];
  outputDir: string;
}): Promise<MediaGenerationResult> {
  if (!input.config.apiKey) {
    return { ok: false, reason: 'speech API key not configured' };
  }

  try {
    await fs.mkdir(input.outputDir, { recursive: true });
    const speechText = speechTextFromReply(input.text);
    const response = await fetchWithTimeout(
      `${input.config.baseUrl.replace(/\/$/, '')}/audio/speech`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.config.apiKey}`
        },
        body: JSON.stringify({
          model: input.config.model,
          voice: input.config.voice,
          input: speechText,
          response_format: input.config.responseFormat
        })
      },
      input.config.timeoutMs
    );

    if (!response.ok) {
      return { ok: false, reason: `speech generation failed (${await errorText(response)})` };
    }

    const outputPath = mediaPath(input.outputDir, 'speech', input.config.responseFormat);
    await fs.writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
    return { ok: true, media: { path: outputPath } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
