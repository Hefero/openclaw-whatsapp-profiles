import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import 'dotenv/config';

const botModeSchema = z.enum(['observe', 'draft', 'auto']);
const targetModeSchema = z.enum(['observe', 'draft', 'auto']);
const targetTypeSchema = z.enum(['contact', 'group']);

const quietHoursSchema = z.object({
  enabled: z.boolean().default(true),
  start: z.string().regex(/^\d{2}:\d{2}$/).default('22:00'),
  end: z.string().regex(/^\d{2}:\d{2}$/).default('08:00'),
  timezone: z.string().default('America/Sao_Paulo')
});

const guidanceProfileSchema = z.object({
  label: z.string().optional(),
  language: z.string().default('pt-BR'),
  tone: z.string().default('natural, breve e direto'),
  identityPolicy: z.enum(['masked', 'open']).default('masked'),
  tools: z
    .object({
      webSearch: z.boolean().default(false),
      localRead: z.boolean().default(false)
    })
    .default({}),
  voice: z
    .object({
      enabled: z.boolean().default(false),
      transcribe: z.boolean().default(true),
      language: z.string().optional(),
      maxAudioBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(25 * 1024 * 1024)
    })
    .default({}),
  instructions: z.array(z.string()).default([]),
  boundaries: z.array(z.string()).default([]),
  maxResponseChars: z.number().int().min(80).max(4000).default(700)
});

const targetAutoReplySchema = z.object({
  enabled: z.boolean().default(false),
  requireMention: z.boolean().default(true),
  requireDirectReply: z.boolean().default(false),
  maxRepliesPerHour: z.number().int().min(0).max(240).optional()
});

const conversationContextSchema = z.object({
  enabled: z.boolean().default(true),
  maxMessages: z.number().int().min(0).max(50).default(8),
  maxAgeMinutes: z.number().int().min(1).max(10080).default(360),
  includeOwnReplies: z.boolean().default(true)
});

const conversationContextOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  maxMessages: z.number().int().min(0).max(50).optional(),
  maxAgeMinutes: z.number().int().min(1).max(10080).optional(),
  includeOwnReplies: z.boolean().optional()
});

const targetSchema = z.object({
  id: z.string().min(1),
  type: targetTypeSchema,
  label: z.string().optional(),
  openclawTarget: z.string().optional(),
  profile: z.string().default('default'),
  mode: targetModeSchema.default('observe'),
  enabled: z.boolean().default(true),
  autoReply: targetAutoReplySchema.default({}),
  context: conversationContextOverrideSchema.default({})
});

const defaultsSchema = z.object({
  profile: z.string().default('default'),
  mode: targetModeSchema.default('observe')
});

const policySchema = z.object({
  defaults: defaultsSchema.default({}),
  profiles: z
    .record(guidanceProfileSchema)
    .default({
      default: {
        label: 'Default',
        language: 'pt-BR',
        tone: 'natural, breve e direto',
        instructions: ['Responda como assistente pessoal, sem parecer atendimento comercial.'],
        boundaries: ['Nao assuma compromissos, pagamentos ou decisoes sensiveis sem revisao humana.'],
        maxResponseChars: 700
      }
    }),
  targets: z.array(targetSchema).default([]),
  allowContacts: z.array(z.string()).default([]),
  denyContacts: z.array(z.string()).default([]),
  allowGroups: z.boolean().default(false),
  autoSendContacts: z.array(z.string()).default([]),
  conversationContext: conversationContextSchema.default({}),
  quietHours: quietHoursSchema.default({}),
  maxAutoRepliesPerHour: z.number().int().min(0).max(60).default(5)
});

export type BotMode = z.infer<typeof botModeSchema>;
export type BotPolicy = z.infer<typeof policySchema>;
export type GuidanceProfile = z.infer<typeof guidanceProfileSchema>;
export type TargetConfig = z.infer<typeof targetSchema>;

export type AppConfig = {
  mode: BotMode;
  logLevel: string;
  policyPath: string;
  policy: BotPolicy;
  openclaw: {
    pollIntervalMs: number;
    readLimit: number;
    processExistingMessages: boolean;
  };
  responder: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
  };
  transcriber: {
    baseUrl: string;
    apiKey?: string;
    model: string;
    language?: string;
    prompt?: string;
    timeoutMs: number;
  };
};

const defaultPolicy: BotPolicy = policySchema.parse({});

function readPolicy(policyPath: string): BotPolicy {
  if (!fs.existsSync(policyPath)) {
    return defaultPolicy;
  }

  const raw = fs.readFileSync(policyPath, 'utf8');
  return policySchema.parse(JSON.parse(raw));
}

export function loadConfig(): AppConfig {
  const policyPath = path.resolve(process.env.BOT_POLICY_PATH ?? './config/bot-policy.local.json');
  const codexProxyHost = process.env.CODEX_PROXY_HOST ?? '127.0.0.1';
  const codexProxyPort = process.env.CODEX_PROXY_PORT ?? '8787';
  const codexProxyEnabled = process.env.CODEX_PROXY_ENABLED !== 'false';
  const codexProxyBaseUrl = `http://${codexProxyHost}:${codexProxyPort}/v1`;
  const proxyTranscriberProvider = process.env.CODEX_PROXY_TRANSCRIBER_PROVIDER;
  const defaultTranscriberModel =
    proxyTranscriberProvider === 'local-whisper'
      ? process.env.WHISPER_LOCAL_MODEL ?? 'base'
      : 'gpt-4o-mini-transcribe';

  return {
    mode: botModeSchema.parse(process.env.BOT_MODE ?? 'observe'),
    logLevel: process.env.BOT_LOG_LEVEL ?? 'info',
    policyPath,
    policy: readPolicy(policyPath),
    openclaw: {
      pollIntervalMs: Number(process.env.OPENCLAW_POLL_INTERVAL_MS ?? '10000'),
      readLimit: Number(process.env.OPENCLAW_READ_LIMIT ?? '10'),
      processExistingMessages: process.env.BOT_PROCESS_EXISTING_MESSAGES === 'true'
    },
    responder: {
      baseUrl:
        process.env.RESPONDER_BASE_URL ?? `http://${codexProxyHost}:${codexProxyPort}/v1`,
      apiKey: process.env.RESPONDER_API_KEY ?? process.env.CODEX_PROXY_API_KEY,
      model: process.env.RESPONDER_MODEL ?? process.env.CODEX_PROXY_MODEL ?? 'gpt-5.4',
      timeoutMs: Number(process.env.RESPONDER_TIMEOUT_MS ?? '120000')
    },
    transcriber: {
      baseUrl:
        process.env.TRANSCRIBER_BASE_URL ??
        (codexProxyEnabled ? codexProxyBaseUrl : 'https://api.openai.com/v1'),
      apiKey:
        process.env.TRANSCRIBER_API_KEY ??
        (codexProxyEnabled ? process.env.CODEX_PROXY_API_KEY : process.env.RESPONDER_API_KEY),
      model: process.env.TRANSCRIBER_MODEL ?? process.env.CODEX_PROXY_TRANSCRIBER_MODEL ?? defaultTranscriberModel,
      language: process.env.TRANSCRIBER_LANGUAGE,
      prompt: process.env.TRANSCRIBER_PROMPT,
      timeoutMs: Number(process.env.TRANSCRIBER_TIMEOUT_MS ?? '60000')
    }
  };
}
