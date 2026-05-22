import 'dotenv/config';

import { spawnSync } from 'node:child_process';

const probes = [
  'messages.visibleReplies',
  'messages.groupChat.visibleReplies',
  'channels.whatsapp.dmPolicy',
  'channels.whatsapp.allowFrom',
  'channels.whatsapp.groupPolicy',
  'channels.whatsapp.groupAllowFrom',
  'channels.whatsapp.groups',
  'channels.whatsapp.direct',
  'channels.whatsapp.selfChatMode',
  'channels.whatsapp.configWrites',
  'channels.whatsapp.pluginHooks'
];

function statusLine(name: string, ok: boolean): string {
  return `${ok ? 'yes' : 'no '}  ${name}`;
}

function runInstalledOpenClaw(args: string[]): { status: number; stdout: string; stderr: string } {
  const command = process.env.OPENCLAW_COMMAND || 'openclaw';
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd', ['/c', command, ...args], {
          encoding: 'utf8',
          env: process.env,
          maxBuffer: 20 * 1024 * 1024
        })
      : spawnSync(command, args, {
          encoding: 'utf8',
          env: process.env,
          maxBuffer: 20 * 1024 * 1024
        });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr:
      result.stderr ??
      ((result.error as NodeJS.ErrnoException | undefined)?.message
        ? `${(result.error as NodeJS.ErrnoException).message}\n`
        : '')
  };
}

function extractFirstJsonObject(value: string): unknown | undefined {
  const start = value.indexOf('{');
  if (start < 0) {
    return undefined;
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < value.length; i += 1) {
    const char = value[i];

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
        return JSON.parse(value.slice(start, i + 1)) as unknown;
      }
    }
  }

  return undefined;
}

function getSchemaProperty(schema: unknown, property: string): unknown | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return undefined;
  }

  const obj = schema as Record<string, unknown>;
  const properties = obj.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    return (properties as Record<string, unknown>)[property];
  }

  return undefined;
}

function hasSchemaPath(schema: unknown, path: string): boolean {
  let current: unknown = schema;
  for (const part of path.split('.')) {
    current = getSchemaProperty(current, part);
    if (!current) {
      return false;
    }
  }
  return true;
}

const version = runInstalledOpenClaw(['--version']);
if (version.status === 0) {
  console.log(`openclaw: ${version.stdout.trim() || 'version command returned empty output'}`);
} else {
  console.log(`openclaw version failed: ${version.stderr || version.stdout}`);
  console.log('Run this in the same terminal where `openclaw` works, or fix OPENCLAW_COMMAND in .env.');
  process.exit(version.status);
}

const validation = runInstalledOpenClaw(['config', 'validate']);
console.log(`config validate: ${validation.status === 0 ? 'ok' : 'failed'}`);
if (validation.status !== 0) {
  console.log((validation.stderr || validation.stdout).trim());
}

const schema = runInstalledOpenClaw(['config', 'schema']);
const parsedSchema = extractFirstJsonObject(`${schema.stdout}\n${schema.stderr}`);
if (!parsedSchema) {
  console.log(`config schema failed: ${(schema.stderr || schema.stdout).trim()}`);
  process.exit(schema.status);
}

console.log('\nSchema probes:');
for (const probe of probes) {
  console.log(statusLine(probe, hasSchemaPath(parsedSchema, probe)));
}

console.log('\nRead this as a coarse check only. If a probe says no, do not write that key.');
