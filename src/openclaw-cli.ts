import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

export type OpenClawMessage = {
  id: string;
  target: string;
  text: string;
  fromMe: boolean;
  timestamp?: string | number;
  raw: unknown;
};

export type OpenClawSendResult = {
  messageId?: string;
  raw: unknown;
};

export type OpenClawMediaSendOptions = {
  message?: string;
  media: string;
  forceDocument?: boolean;
};

export type OpenClawStickerSendOptions = {
  media: string;
  message?: string;
};

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
  unavailable: boolean;
};

function pathExists(candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}

export function resolveOpenClawCommand(): string {
  if (process.env.OPENCLAW_COMMAND) {
    return process.env.OPENCLAW_COMMAND;
  }

  const localCommand = path.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw'
  );
  if (pathExists(localCommand)) {
    return localCommand;
  }

  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [
    appData && path.join(appData, 'npm', 'openclaw.cmd'),
    localAppData && path.join(localAppData, 'npm', 'openclaw.cmd')
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  return 'openclaw';
}

function resolveOpenClawConfigPath(): string {
  const explicitConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicitConfigPath) {
    return path.resolve(explicitConfigPath);
  }

  const explicitHome = process.env.OPENCLAW_HOME?.trim();
  const homeRoot = explicitHome ? path.resolve(explicitHome) : os.homedir();
  return path.join(homeRoot, '.openclaw', 'openclaw.json');
}

async function resolveOpenClawWorkspace(): Promise<string> {
  const fallback = path.join(os.homedir(), '.openclaw', 'workspace');
  try {
    const raw = await fs.readFile(resolveOpenClawConfigPath(), 'utf8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const agents = getObject(config.agents);
    const defaults = getObject(agents?.defaults);
    const workspace = getString(defaults?.workspace);
    return workspace ? path.resolve(workspace) : fallback;
  } catch {
    return fallback;
  }
}

async function stageGatewayMedia(mediaPath: string): Promise<string> {
  const workspace = await resolveOpenClawWorkspace();
  const stageDir = path.join(workspace, 'whatsapp-chatbot-media');
  await fs.mkdir(stageDir, { recursive: true });
  const source = path.resolve(mediaPath);
  const staged = path.join(stageDir, path.basename(source));
  if (source.toLowerCase() !== staged.toLowerCase()) {
    await fs.copyFile(source, staged);
  }
  return staged;
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): RunResult {
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd', ['/c', command, ...args], {
          env,
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024
        })
      : spawnSync(command, args, {
          env,
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024
        });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const output = `${stdout}\n${stderr}`;
  const unavailable =
    (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ||
    output.includes('não é reconhecido') ||
    output.includes('nao e reconhecido') ||
    output.includes('is not recognized');

  return {
    status: result.status ?? 1,
    stdout,
    stderr,
    unavailable
  };
}

function isUnavailable(result: { error?: NodeJS.ErrnoException; stdout: string; stderr: string }): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return (
    result.error?.code === 'ENOENT' ||
    output.includes('nÃ£o Ã© reconhecido') ||
    output.includes('nao e reconhecido') ||
    output.includes('is not recognized')
  );
}

function runCommandAsync(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', command, ...args], {
            env,
            windowsHide: true
          })
        : spawn(command, args, {
            env
          });
    let stdout = '';
    let stderr = '';
    let error: NodeJS.ErrnoException | undefined;
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
    child.on('error', (childError: NodeJS.ErrnoException) => {
      error = childError;
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      const timeoutMessage = timedOut ? `openclaw command timed out after ${timeoutMs}ms` : '';
      const finalStderr = [stderr, timeoutMessage].filter(Boolean).join('\n');
      resolve({
        status: timedOut ? 1 : status ?? 1,
        stdout,
        stderr: finalStderr,
        unavailable: isUnavailable({ error, stdout, stderr: finalStderr })
      });
    });
  });
}

function runNpx(args: string[], env: NodeJS.ProcessEnv): RunResult {
  const cacheDir = path.join(process.cwd(), '.tmp-npm-cache');
  const npxPackage = process.env.OPENCLAW_NPX_PACKAGE ?? 'openclaw@latest';
  const npxArgs = ['--yes', '--cache', cacheDir, '--package', npxPackage, 'openclaw', ...args];

  return process.platform === 'win32'
    ? runCommand('npx', npxArgs, { ...env, NPM_CONFIG_CACHE: cacheDir })
    : runCommand('npx', npxArgs, { ...env, NPM_CONFIG_CACHE: cacheDir });
}

function runNpxAsync(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
  const cacheDir = path.join(process.cwd(), '.tmp-npm-cache');
  const npxPackage = process.env.OPENCLAW_NPX_PACKAGE ?? 'openclaw@latest';
  const npxArgs = ['--yes', '--cache', cacheDir, '--package', npxPackage, 'openclaw', ...args];

  return runCommandAsync('npx', npxArgs, { ...env, NPM_CONFIG_CACHE: cacheDir }, timeoutMs);
}

export function runOpenClaw(args: string[]): RunResult {
  const env = {
    ...process.env,
    NPM_CONFIG_CACHE: path.join(process.cwd(), '.tmp-npm-cache')
  };

  const direct = runCommand(resolveOpenClawCommand(), args, env);
  if (direct.status === 0 || !direct.unavailable) {
    return direct;
  }

  return runNpx(args, env);
}

export async function runOpenClawAsync(args: string[]): Promise<RunResult> {
  const env = {
    ...process.env,
    NPM_CONFIG_CACHE: path.join(process.cwd(), '.tmp-npm-cache')
  };
  const timeoutMs = Number(process.env.OPENCLAW_COMMAND_TIMEOUT_MS ?? '30000');

  const direct = await runCommandAsync(resolveOpenClawCommand(), args, env, timeoutMs);
  if (direct.status === 0 || !direct.unavailable) {
    return direct;
  }

  return runNpxAsync(args, env, timeoutMs);
}

function extractFirstJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // OpenClaw can print plugin logs after JSON. Parse the first balanced JSON value.
  }

  const start = trimmed.search(/[\[{]/);
  if (start < 0) {
    return undefined;
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      stack.push('}');
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== char) {
        return undefined;
      }
      if (stack.length === 0) {
        return JSON.parse(trimmed.slice(start, i + 1));
      }
    }
  }

  return undefined;
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function collectMessageLike(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  const obj = getObject(value);
  if (!obj) {
    return [];
  }

  const keys = ['messages', 'items', 'results', 'data'];
  for (const key of keys) {
    if (Array.isArray(obj[key])) {
      return obj[key] as unknown[];
    }
  }

  const payload = getObject(obj.payload);
  if (payload) {
    return collectMessageLike(payload);
  }

  const result = getObject(obj.result);
  if (result) {
    return collectMessageLike(result);
  }

  return [obj];
}

function normalizeMessage(value: unknown, target: string): OpenClawMessage | undefined {
  const obj = getObject(value);
  if (!obj) {
    return undefined;
  }

  const key = getObject(obj.key);
  const messageObj = getObject(obj.message);
  const payload = getObject(obj.payload);

  const id =
    getString(obj.id) ??
    getString(obj.messageId) ??
    getString(key?.id) ??
    getString(payload?.id);
  const text =
    getString(obj.text) ??
    getString(obj.body) ??
    getString(obj.content) ??
    getString(obj.message) ??
    getString(messageObj?.text) ??
    getString(payload?.text);

  if (!id || !text) {
    return undefined;
  }

  return {
    id,
    target,
    text,
    fromMe: getBoolean(obj.fromMe) ?? getBoolean(key?.fromMe) ?? false,
    timestamp:
      getNumber(obj.timestamp) ??
      getString(obj.timestamp) ??
      getNumber(obj.messageTimestamp) ??
      getString(obj.messageTimestamp) ??
      getNumber(obj.createdAt) ??
      getString(obj.createdAt) ??
      getNumber(key?.timestamp) ??
      getString(key?.timestamp) ??
      getNumber(payload?.timestamp) ??
      getString(payload?.timestamp) ??
      getNumber(payload?.createdAt) ??
      getString(payload?.createdAt),
    raw: value
  };
}

export function readOpenClawMessages(target: string, limit: number): OpenClawMessage[] {
  const result = runOpenClaw([
    'message',
    'read',
    '--channel',
    'whatsapp',
    '--target',
    target,
    '--limit',
    String(limit),
    '--json'
  ]);

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `openclaw message read failed (${result.status})`);
  }

  const parsed = extractFirstJson(result.stdout);
  return collectMessageLike(parsed)
    .map((item) => normalizeMessage(item, target))
    .filter((item): item is OpenClawMessage => Boolean(item));
}

export async function readOpenClawMessagesAsync(target: string, limit: number): Promise<OpenClawMessage[]> {
  const result = await runOpenClawAsync([
    'message',
    'read',
    '--channel',
    'whatsapp',
    '--target',
    target,
    '--limit',
    String(limit),
    '--json'
  ]);

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `openclaw message read failed (${result.status})`);
  }

  const parsed = extractFirstJson(result.stdout);
  return collectMessageLike(parsed)
    .map((item) => normalizeMessage(item, target))
    .filter((item): item is OpenClawMessage => Boolean(item));
}

export function sendOpenClawMessage(target: string, message: string): OpenClawSendResult {
  const result = runOpenClaw([
    'message',
    'send',
    '--channel',
    'whatsapp',
    '--target',
    target,
    '--message',
    message,
    '--json'
  ]);

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `openclaw message send failed (${result.status})`);
  }

  const parsed = extractFirstJson(result.stdout);
  const obj = getObject(parsed);
  const payload = getObject(obj?.payload);
  const inner = getObject(payload?.result);

  return {
    messageId: getString(inner?.messageId) ?? getString(obj?.messageId),
    raw: parsed
  };
}

export async function sendOpenClawMessageAsync(target: string, message: string): Promise<OpenClawSendResult> {
  const result = await runOpenClawAsync([
    'message',
    'send',
    '--channel',
    'whatsapp',
    '--target',
    target,
    '--message',
    message,
    '--json'
  ]);

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `openclaw message send failed (${result.status})`);
  }

  const parsed = extractFirstJson(result.stdout);
  const obj = getObject(parsed);
  const payload = getObject(obj?.payload);
  const inner = getObject(payload?.result);

  return {
    messageId: getString(inner?.messageId) ?? getString(obj?.messageId),
    raw: parsed
  };
}

export async function sendOpenClawMediaAsync(
  target: string,
  opts: OpenClawMediaSendOptions
): Promise<OpenClawSendResult> {
  const args = [
    'message',
    'send',
    '--channel',
    'whatsapp',
    '--target',
    target,
    '--media',
    opts.media,
    '--json'
  ];

  if (opts.message?.trim()) {
    args.push('--message', opts.message.trim());
  }

  if (opts.forceDocument) {
    args.push('--force-document');
  }

  const result = await runOpenClawAsync(args);

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `openclaw media send failed (${result.status})`);
  }

  const parsed = extractFirstJson(result.stdout);
  const obj = getObject(parsed);
  const payload = getObject(obj?.payload);
  const inner = getObject(payload?.result);

  return {
    messageId: getString(inner?.messageId) ?? getString(obj?.messageId),
    raw: parsed
  };
}

export async function sendOpenClawStickerAsync(
  target: string,
  opts: OpenClawStickerSendOptions
): Promise<OpenClawSendResult> {
  const media = await stageGatewayMedia(opts.media);
  const params = {
    channel: 'whatsapp',
    action: 'upload-file',
    params: {
      to: target,
      media,
      contentType: 'image/webp',
      filename: path.basename(media),
      asSticker: true,
      ...(opts.message?.trim() ? { message: opts.message.trim() } : {})
    },
    idempotencyKey: crypto.randomUUID()
  };
  const timeoutMs = Number(process.env.OPENCLAW_GATEWAY_CALL_TIMEOUT_MS ?? process.env.OPENCLAW_COMMAND_TIMEOUT_MS ?? '30000');
  const result = await runOpenClawAsync([
    'gateway',
    'call',
    'message.action',
    '--params',
    JSON.stringify(params),
    '--timeout',
    String(timeoutMs),
    '--json'
  ]);

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `openclaw sticker send failed (${result.status})`);
  }

  const parsed = extractFirstJson(result.stdout);
  const obj = getObject(parsed);
  const payload = getObject(obj?.payload);
  const inner = getObject(payload?.result) ?? getObject(obj?.result);

  return {
    messageId: getString(inner?.messageId) ?? getString(payload?.messageId) ?? getString(obj?.messageId),
    raw: parsed
  };
}

export function toOpenClawTarget(id: string, explicitTarget?: string): string {
  if (explicitTarget) {
    return explicitTarget;
  }

  if (id.endsWith('@s.whatsapp.net')) {
    return `+${id.slice(0, -'@s.whatsapp.net'.length)}`;
  }

  return id;
}
