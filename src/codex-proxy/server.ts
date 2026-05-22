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
  bin: z.string().default(process.platform === 'win32' ? 'codex.cmd' : 'codex')
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
  bin: process.env.CODEX_PROXY_CODEX_BIN
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

function isAuthorized(request: http.IncomingMessage): boolean {
  if (!serverConfig.apiKey) {
    return true;
  }

  return request.headers.authorization === `Bearer ${serverConfig.apiKey}`;
}

function headerEnabled(request: http.IncomingMessage, name: string): boolean {
  return request.headers[name.toLowerCase()]?.toString().toLowerCase() === 'true';
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, {
        ok: true,
        model: serverConfig.model,
        sandbox: serverConfig.sandbox,
        allowWebSearch: serverConfig.allowWebSearch
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
      workdir: runnerConfig.workdir,
      bin: serverConfig.bin,
      authEnabled: Boolean(serverConfig.apiKey)
    },
    'Codex proxy listening'
  );
});
