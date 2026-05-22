import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
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
  transcriberTimeoutMs: z.coerce.number().int().min(1000).default(60000)
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
  transcriberTimeoutMs: process.env.CODEX_PROXY_TRANSCRIBER_TIMEOUT_MS
});

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
          Boolean(serverConfig.transcriberApiKey)
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
      workdir: runnerConfig.workdir,
      bin: serverConfig.bin,
      authEnabled: Boolean(serverConfig.apiKey)
    },
    'Codex proxy listening'
  );
});
