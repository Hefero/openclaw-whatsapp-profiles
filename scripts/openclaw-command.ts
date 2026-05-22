import 'dotenv/config';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return 'openclaw';
}
