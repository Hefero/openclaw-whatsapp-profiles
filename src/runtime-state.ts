import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const outboundSchema = z.object({
  target: z.string(),
  text: z.string(),
  createdAt: z.number()
});

const conversationEntrySchema = z.object({
  role: z.enum(['inbound', 'outbound']),
  text: z.string(),
  createdAt: z.number()
});

const stateSchema = z.object({
  seenByTarget: z.record(z.array(z.string())).default({}),
  outbound: z.array(outboundSchema).default([]),
  conversationByTarget: z.record(z.array(conversationEntrySchema)).default({})
});

export type RuntimeState = z.infer<typeof stateSchema>;
export type ConversationEntry = z.infer<typeof conversationEntrySchema>;

const statePath = path.resolve('./data/openclaw-worker-state.json');

export function loadRuntimeState(): RuntimeState {
  if (!fs.existsSync(statePath)) {
    return stateSchema.parse({});
  }

  return stateSchema.parse(JSON.parse(fs.readFileSync(statePath, 'utf8')));
}

export function saveRuntimeState(state: RuntimeState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function hasSeen(state: RuntimeState, target: string, messageId: string): boolean {
  return Boolean(state.seenByTarget[target]?.includes(messageId));
}

export function markSeen(state: RuntimeState, target: string, messageIds: string[]): void {
  const existing = new Set(state.seenByTarget[target] ?? []);
  for (const id of messageIds) {
    existing.add(id);
  }
  state.seenByTarget[target] = [...existing].slice(-500);
}

export function rememberOutbound(state: RuntimeState, target: string, text: string): void {
  const cutoff = Date.now() - 10 * 60 * 1000;
  state.outbound = [
    ...state.outbound.filter((item) => item.createdAt >= cutoff),
    { target, text: normalizeRecentText(text), createdAt: Date.now() }
  ].slice(-100);
}

export function rememberConversationEntry(
  state: RuntimeState,
  target: string,
  role: ConversationEntry['role'],
  text: string
): void {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return;
  }

  const existing = state.conversationByTarget[target] ?? [];
  state.conversationByTarget[target] = [
    ...existing,
    { role, text: normalized, createdAt: Date.now() }
  ].slice(-100);
}

export function getConversationContext(
  state: RuntimeState,
  target: string,
  opts: {
    enabled: boolean;
    maxMessages: number;
    maxAgeMinutes: number;
    includeOwnReplies: boolean;
  }
): ConversationEntry[] {
  if (!opts.enabled || opts.maxMessages <= 0) {
    return [];
  }

  const cutoff = Date.now() - opts.maxAgeMinutes * 60 * 1000;
  return (state.conversationByTarget[target] ?? [])
    .filter((item) => item.createdAt >= cutoff)
    .filter((item) => opts.includeOwnReplies || item.role !== 'outbound')
    .slice(-opts.maxMessages);
}

export function countRecentOutbound(state: RuntimeState, target: string, windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  return state.outbound.filter((item) => item.target === target && item.createdAt >= cutoff).length;
}

export function isRecentOutbound(state: RuntimeState, target: string, text: string): boolean {
  const cutoff = Date.now() - 10 * 60 * 1000;
  const normalizedText = normalizeRecentText(text);
  return state.outbound.some(
    (item) =>
      item.target === target &&
      normalizeRecentText(item.text) === normalizedText &&
      item.createdAt >= cutoff
  );
}

function normalizeRecentText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}
