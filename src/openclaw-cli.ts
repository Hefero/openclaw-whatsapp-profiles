import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

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

function runNpx(args: string[], env: NodeJS.ProcessEnv): RunResult {
  const cacheDir = path.join(process.cwd(), '.tmp-npm-cache');
  const npxPackage = process.env.OPENCLAW_NPX_PACKAGE ?? 'openclaw@latest';
  const npxArgs = ['--yes', '--cache', cacheDir, '--package', npxPackage, 'openclaw', ...args];

  return process.platform === 'win32'
    ? runCommand('npx', npxArgs, { ...env, NPM_CONFIG_CACHE: cacheDir })
    : runCommand('npx', npxArgs, { ...env, NPM_CONFIG_CACHE: cacheDir });
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
    timestamp: getString(obj.timestamp) ?? getString(obj.createdAt) ?? getString(payload?.timestamp),
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

export function toOpenClawTarget(id: string, explicitTarget?: string): string {
  if (explicitTarget) {
    return explicitTarget;
  }

  if (id.endsWith('@s.whatsapp.net')) {
    return `+${id.slice(0, -'@s.whatsapp.net'.length)}`;
  }

  return id;
}
