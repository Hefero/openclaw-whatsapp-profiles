import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import process from 'node:process';
import { parse } from 'node:url';

import { runOpenClawSend } from './openclaw-send.js';

type SendPayload = {
  target?: string;
  message?: string;
  verbose?: boolean;
};

type HealthPayload = {
  ok: boolean;
  mode: 'daemon';
  node: string;
};

const PORT = Number(process.env.OPENCLAW_CONTROL_PORT ?? '8788');
const HOST = process.env.OPENCLAW_CONTROL_HOST ?? '127.0.0.1';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: SendPayload = {};

  try {
    const body = await readBody(req);
    if (body.trim()) {
      payload = JSON.parse(body);
    }
  } catch (error) {
    jsonResponse(res, 400, {
      ok: false,
      error: 'invalid-json',
      details: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const target = payload.target;
  const message = payload.message;

  if (!target || !message) {
    jsonResponse(res, 400, {
      ok: false,
      error: 'missing-fields',
      details: 'target and message are required'
    });
    return;
  }

  const status = runOpenClawSend({
    target,
    message,
    verbose: Boolean(payload.verbose)
  });

  if (status !== 0) {
    jsonResponse(res, 500, {
      ok: false,
      error: 'openclaw-send-failed',
      status
    });
    return;
  }

  jsonResponse(res, 200, { ok: true, status: 0 });
}

function handleHealthz(res: ServerResponse): void {
  const payload: HealthPayload = {
    ok: true,
    mode: 'daemon',
    node: process.version
  };
  jsonResponse(res, 200, payload);
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const parsed = parse(req.url ?? '/', true);

  if (req.method === 'GET' && parsed.pathname === '/healthz') {
    handleHealthz(res);
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/send') {
    void handleSend(req, res).catch((error) => {
      jsonResponse(res, 500, {
        ok: false,
        error: 'internal',
        details: error instanceof Error ? error.message : String(error)
      });
    });
    return;
  }

  res.statusCode = 404;
  res.end('Not found');
}

createServer(route).listen(PORT, HOST, () => {
  console.log(`openclaw control daemon running on http://${HOST}:${PORT}`);
});
