import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import 'dotenv/config';

import { loadConfig } from '../src/config.js';

function resolveOpenClawConfigPath(): string {
  const explicitConfigPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicitConfigPath) {
    return path.resolve(explicitConfigPath);
  }

  const explicitHome = process.env.OPENCLAW_HOME?.trim();
  const homeRoot = explicitHome ? path.resolve(explicitHome) : os.homedir();
  return path.join(homeRoot, '.openclaw', 'openclaw.json');
}

const configPath = resolveOpenClawConfigPath();
const backupDir = path.resolve('data', 'runtime', 'openclaw-config-backups');

if (!fs.existsSync(configPath)) {
  console.log(`OpenClaw config not found: ${configPath}`);
  process.exit(0);
}

const raw = fs.readFileSync(configPath, 'utf8');
const config = JSON.parse(raw) as Record<string, unknown>;
const assistantModel = process.env.OPENCLAW_AGENTS_ASSISTANT_MODEL ?? 'openai-codex/gpt-5.4';
const appConfig = loadConfig();
const openWhatsAppDms =
  process.env.OPENCLAW_WHATSAPP_DM_POLICY === 'open' ||
  process.env.OPENCLAW_WHATSAPP_ALLOW_ALL_DMS === 'true';

let changed = false;
const removedKeys: string[] = [];

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }

  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function normalizeWhatsAppTarget(value: string): string | undefined {
  if (value.trim() === '*') {
    return '*';
  }

  const beforeAt = value.split('@')[0] ?? value;
  const withoutDevice = beforeAt.split(':')[0] ?? beforeAt;
  const digits = withoutDevice.replace(/\D/g, '');

  if (digits.length < 8) {
    return undefined;
  }

  return `+${digits}`;
}

function hasWildcard(values: string[]): boolean {
  return values.some((value) => value.trim() === '*');
}

function collectAllowedWhatsAppNumbers(): string[] {
  const values = new Set<string>();

  for (const target of appConfig.policy.targets) {
    if (!target.enabled || target.type !== 'contact') {
      continue;
    }

    const normalized = normalizeWhatsAppTarget(target.openclawTarget ?? target.id);
    if (normalized) {
      values.add(normalized);
    }
  }

  for (const contact of appConfig.policy.allowContacts) {
    const normalized = normalizeWhatsAppTarget(contact);
    if (normalized) {
      values.add(normalized);
    }
  }

  if (values.has('*')) {
    return ['*'];
  }

  return [...values].sort();
}

function collectConfiguredWhatsAppGroups(): Array<{ id: string; requireMention: boolean }> {
  const groups: Array<{ id: string; requireMention: boolean }> = [];

  for (const target of appConfig.policy.targets) {
    if (!target.enabled || target.type !== 'group') {
      continue;
    }

    const id = (target.openclawTarget ?? target.id).trim();
    if (!id.endsWith('@g.us')) {
      continue;
    }

    groups.push({
      id,
      requireMention: target.autoReply.requireMention !== false
    });
  }

  return groups;
}

const channels = objectAt(config, 'channels');
const whatsapp = objectAt(channels, 'whatsapp');
if (whatsapp.enabled !== true) {
  whatsapp.enabled = true;
  changed = true;
}

for (const key of ['pluginHooks']) {
  if (key in whatsapp) {
    delete whatsapp[key];
    removedKeys.push(key);
    changed = true;
  }
}

if (openWhatsAppDms || hasWildcard(appConfig.policy.allowContacts)) {
  const currentAllowFrom = JSON.stringify(whatsapp.allowFrom ?? []);
  const nextAllowFrom = JSON.stringify(['*']);

  if (whatsapp.dmPolicy !== 'open') {
    whatsapp.dmPolicy = 'open';
    changed = true;
    console.log('Set channels.whatsapp.dmPolicy=open');
  }

  if (currentAllowFrom !== nextAllowFrom) {
    whatsapp.allowFrom = ['*'];
    changed = true;
    console.log('Set channels.whatsapp.allowFrom=*');
  }
} else {
  const allowFrom = collectAllowedWhatsAppNumbers();
  const currentAllowFrom = JSON.stringify(whatsapp.allowFrom ?? []);
  const nextAllowFrom = JSON.stringify(allowFrom);

  if (whatsapp.dmPolicy !== 'allowlist') {
    whatsapp.dmPolicy = 'allowlist';
    changed = true;
    console.log('Set channels.whatsapp.dmPolicy=allowlist');
  }

  if (currentAllowFrom !== nextAllowFrom) {
    whatsapp.allowFrom = allowFrom;
    changed = true;
    console.log(
      allowFrom.length > 0
        ? `Synced channels.whatsapp.allowFrom=${allowFrom.join(', ')}`
        : 'Cleared channels.whatsapp.allowFrom'
    );
  }
}

if (appConfig.policy.allowGroups === true) {
  const currentGroupAllowFrom = JSON.stringify(whatsapp.groupAllowFrom ?? []);
  const nextGroupAllowFrom = JSON.stringify(['*']);

  if (whatsapp.groupPolicy !== 'open') {
    whatsapp.groupPolicy = 'open';
    changed = true;
    console.log('Set channels.whatsapp.groupPolicy=open');
  }

  if (currentGroupAllowFrom !== nextGroupAllowFrom) {
    whatsapp.groupAllowFrom = ['*'];
    changed = true;
    console.log('Set channels.whatsapp.groupAllowFrom=*');
  }

  const groupTargets = collectConfiguredWhatsAppGroups();
  if (groupTargets.length > 0) {
    const groups = objectAt(whatsapp, 'groups');
    for (const group of groupTargets) {
      const entry = objectAt(groups, group.id);
      if (entry.requireMention !== group.requireMention) {
        entry.requireMention = group.requireMention;
        changed = true;
        console.log(
          `Set channels.whatsapp.groups.${group.id}.requireMention=${group.requireMention}`
        );
      }
    }
  }
} else if (whatsapp.groupPolicy !== 'disabled') {
  whatsapp.groupPolicy = 'disabled';
  changed = true;
  console.log('Set channels.whatsapp.groupPolicy=disabled');
}

const messages = objectAt(config, 'messages');
if (messages.visibleReplies !== 'automatic') {
  messages.visibleReplies = 'automatic';
  changed = true;
  console.log('Set messages.visibleReplies=automatic');
}

const plugins = objectAt(config, 'plugins');
const entries = objectAt(plugins, 'entries');
const dispatchPlugin = objectAt(entries, 'whatsapp-policy-dispatch');
const dispatchConfig = objectAt(dispatchPlugin, 'config');

if (dispatchPlugin.enabled !== true) {
  dispatchPlugin.enabled = true;
  changed = true;
  console.log('Enabled plugins.entries.whatsapp-policy-dispatch');
}

if (dispatchConfig.endpoint !== 'http://127.0.0.1:8790/openclaw/message') {
  dispatchConfig.endpoint = 'http://127.0.0.1:8790/openclaw/message';
  changed = true;
  console.log('Set whatsapp-policy-dispatch endpoint');
}

if (dispatchConfig.timeoutMs !== 30000) {
  dispatchConfig.timeoutMs = 30000;
  changed = true;
  console.log('Set whatsapp-policy-dispatch timeoutMs=30000');
}

const agents = objectAt(config, 'agents');
const defaults = objectAt(agents, 'defaults');
const model = objectAt(defaults, 'model');
if (model.primary !== assistantModel) {
  model.primary = assistantModel;
  changed = true;
  console.log(`Set agents.defaults.model.primary=${assistantModel}`);
}

if (changed) {
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `openclaw.json.bak-${Date.now()}`);
  try {
    fs.copyFileSync(configPath, backupPath);
    console.log(`Backup: ${backupPath}`);
  } catch (error) {
    console.warn(
      `Backup skipped: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (removedKeys.length > 0) {
    console.log(`Removed invalid channels.whatsapp keys: ${removedKeys.join(', ')}`);
  }

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Repaired OpenClaw config: ${configPath}`);
} else {
  console.log('OpenClaw config already matches project policy.');
}
