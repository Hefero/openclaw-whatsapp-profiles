import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pino } from 'pino';
import { loadConfig, type AppConfig, type TargetConfig } from './config.js';
import { decideDelivery } from './delivery-gate.js';
import { resolveConversationContext } from './guidance.js';
import { decideMessageAction } from './policy.js';
import { generateDraftReply } from './responder.js';
import {
  getConversationContext,
  hasSeen,
  isRecentOutbound,
  loadRuntimeState,
  markSeen,
  countRecentOutbound,
  rememberConversationEntry,
  rememberOutbound,
  saveRuntimeState
} from './runtime-state.js';

type InboundPayload = {
  type?: string;
  action?: string;
  sessionKey?: string;
  timestamp?: string | number;
  context?: {
    from?: string;
    content?: string;
    channelId?: string;
    metadata?: Record<string, unknown>;
  };
};

type InboundMessage = {
  id: string;
  remoteJid: string;
  text: string;
  raw: InboundPayload;
};

const startupConfig = loadConfig();
const logger = pino({ level: startupConfig.logLevel });
const host = process.env.WHATSAPP_ASSISTANT_HOOK_HOST ?? '127.0.0.1';
const port = Number(process.env.WHATSAPP_ASSISTANT_HOOK_PORT ?? '8790');
const twilioWebhookPath = process.env.TWILIO_WEBHOOK_PATH ?? '/twilio/whatsapp';
const validateTwilioSignature = process.env.TWILIO_VALIDATE_SIGNATURE === 'true';
const twilioOnly = process.env.WHATSAPP_ASSISTANT_TWILIO_ONLY === 'true';
const workerProcessName = process.env.WORKER_PROCESS_NAME ?? 'openclaw-worker';
const workerProcessArgs = (process.env.WORKER_PROCESS_ARGS ?? 'run openclaw:worker').split(' ');
const workerPidPath = path.resolve('data', 'runtime', `${workerProcessName}.pid.json`);
const logReplyContent = process.env.BOT_LOG_REPLY_CONTENT === 'true';

function registerWorkerProcess(): void {
  const runtimeDir = path.dirname(workerPidPath);
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    workerPidPath,
    JSON.stringify(
      {
        name: workerProcessName,
        pid: process.pid,
        command: 'npm',
        args: workerProcessArgs,
        startedAt: new Date().toISOString(),
        logPath: path.join(runtimeDir, `${workerProcessName}.log`)
      },
      null,
      2
    )
  );
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeContact(value: string): string {
  const trimmed = value.trim();
  if (trimmed.endsWith('@s.whatsapp.net') || trimmed.endsWith('@g.us')) {
    return trimmed;
  }

  const digits = trimmed.replace(/[^\d]/g, '');
  if (digits) {
    return `${digits}@s.whatsapp.net`;
  }

  return trimmed;
}

function groupJidFromSessionKey(sessionKey: string | undefined): string | undefined {
  const match = sessionKey?.match(/(?:^|:)group:([^:]+@g\.us)(?:$|:)/);
  return match?.[1];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function collectInboundIds(payload: InboundPayload): string[] {
  const metadata = payload.context?.metadata ?? {};
  const sessionGroupJid = groupJidFromSessionKey(payload.sessionKey);
  const isGroup = metadata.isGroup === true || Boolean(sessionGroupJid);
  const chatIds = [
    sessionGroupJid,
    getString(metadata.remoteJid),
    getString(metadata.chatId),
    getString(metadata.conversationId),
    getString(metadata.openclawConversationId),
    getString(metadata.jid),
    payload.context?.from
  ];
  const senderIds = [
    getString(metadata.senderId),
    getString(metadata.senderE164),
    getString(metadata.from),
    getString(metadata.participant)
  ];

  return uniqueStrings(
    (isGroup ? [...chatIds, ...senderIds] : [...senderIds, ...chatIds])
      .filter((value): value is string => Boolean(value))
      .map(normalizeContact)
  );
}

function targetMatchesId(target: TargetConfig, id: string): boolean {
  const targetIds = [
    normalizeContact(target.id),
    target.openclawTarget ? normalizeContact(target.openclawTarget) : undefined
  ].filter((value): value is string => Boolean(value));

  return targetIds.includes(id);
}

function findTarget(payload: InboundPayload, config: AppConfig): TargetConfig | undefined {
  const ids = collectInboundIds(payload);
  for (const id of ids) {
    const target = config.policy.targets.find((candidate) => candidate.enabled && targetMatchesId(candidate, id));
    if (target) {
      return target;
    }
  }

  return undefined;
}

function resolveRemoteJid(payload: InboundPayload, target: TargetConfig | undefined): string | undefined {
  if (target) {
    return target.id;
  }

  return collectInboundIds(payload)[0];
}

function normalizeInbound(payload: InboundPayload, remoteJid: string): InboundMessage | undefined {
  const metadata = payload.context?.metadata ?? {};
  const text = payload.context?.content?.trim();
  if (!text) {
    return undefined;
  }

  const id =
    getString(metadata.messageId) ??
    getString(metadata.id) ??
    getString(metadata.stanzaId) ??
    `${payload.sessionKey ?? remoteJid}:${payload.timestamp ?? Date.now()}:${text}`;

  return {
    id,
    remoteJid,
    text,
    raw: payload
  };
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  return body ? JSON.parse(body) : {};
}

async function readForm(request: http.IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(request));
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

function sendXml(response: http.ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/xml; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  response.end(body);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildTwilioResponse(reply?: string): string {
  if (!reply) {
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`;
}

function formToRecord(form: URLSearchParams): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    record[key] = value;
  }
  return record;
}

function getRequestPath(request: http.IncomingMessage): string {
  return new URL(request.url ?? '/', `http://${host}:${port}`).pathname;
}

function getTwilioWebhookUrl(request: http.IncomingMessage): string | undefined {
  const configuredUrl = process.env.TWILIO_WEBHOOK_URL?.trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  const forwardedHost = request.headers['x-forwarded-host']?.toString().split(',')[0]?.trim();
  const hostHeader = forwardedHost || request.headers.host;
  if (!hostHeader) {
    return undefined;
  }

  const forwardedProto = request.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim();
  const protocol = forwardedProto || 'https';
  return `${protocol}://${hostHeader}${request.url ?? twilioWebhookPath}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isValidTwilioSignature(request: http.IncomingMessage, form: URLSearchParams): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const signature = request.headers['x-twilio-signature']?.toString();
  const webhookUrl = getTwilioWebhookUrl(request);
  if (!authToken || !signature || !webhookUrl) {
    return false;
  }

  const signedPayload = [...form.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .reduce((payload, [key, value]) => `${payload}${key}${value}`, webhookUrl);

  const expected = crypto.createHmac('sha1', authToken).update(signedPayload).digest('base64');
  return safeEqual(expected, signature);
}

function twilioFormToInboundPayload(form: URLSearchParams): InboundPayload {
  const data = formToRecord(form);
  const messageId = data.MessageSid || data.SmsMessageSid || data.SmsSid;

  return {
    type: 'message',
    action: 'received',
    sessionKey: 'twilio',
    timestamp: new Date().toISOString(),
    context: {
      from: data.From,
      content: data.Body,
      channelId: 'whatsapp',
      metadata: {
        provider: 'twilio',
        messageId,
        smsMessageSid: data.SmsMessageSid,
        smsSid: data.SmsSid,
        messageSid: data.MessageSid,
        accountSid: data.AccountSid,
        from: data.From,
        to: data.To,
        waId: data.WaId,
        profileName: data.ProfileName,
        messageType: data.MessageType,
        numMedia: data.NumMedia
      }
    }
  };
}

function isTwilioSandboxDefaultEcho(text: string): boolean {
  return (
    text.startsWith('You said :') &&
    text.includes("Configure your WhatsApp Sandbox's Inbound URL to change this message.")
  );
}

function replyFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const action = 'action' in result ? result.action : undefined;
  const reply = 'reply' in result ? result.reply : undefined;
  return action === 'reply' && typeof reply === 'string' && reply.length > 0 ? reply : undefined;
}

async function handleInbound(payload: InboundPayload): Promise<unknown> {
  const config = loadConfig();

  if (payload.context?.channelId !== 'whatsapp') {
    return { ok: true, action: 'ignored', reason: 'not whatsapp' };
  }

  const target = findTarget(payload, config);
  const remoteJid = resolveRemoteJid(payload, target);
  if (!remoteJid) {
    logger.info(
      { from: payload.context?.from, metadata: payload.context?.metadata },
      'inbound whatsapp message did not include a usable sender id'
    );
    return { ok: true, action: 'ignored', reason: 'sender not detected' };
  }

  const message = normalizeInbound(payload, remoteJid);
  if (!message) {
    return { ok: true, action: 'ignored', reason: 'empty message' };
  }
  const targetLabel = target?.label ?? message.remoteJid;

  if (isTwilioSandboxDefaultEcho(message.text)) {
    logger.info(
      { target: targetLabel, messageId: message.id },
      'ignored twilio sandbox default echo'
    );
    return { ok: true, action: 'ignored', reason: 'twilio sandbox default echo' };
  }

  const state = loadRuntimeState();
  if (hasSeen(state, message.remoteJid, message.id)) {
    return { ok: true, action: 'ignored', reason: 'duplicate message' };
  }

  if (isRecentOutbound(state, message.remoteJid, message.text)) {
    markSeen(state, message.remoteJid, [message.id]);
    saveRuntimeState(state);
    logger.info(
      { target: targetLabel, messageId: message.id },
      'ignored recent outbound echo'
    );
    return { ok: true, action: 'ignored', reason: 'recent outbound echo' };
  }

  markSeen(state, message.remoteJid, [message.id]);
  saveRuntimeState(state);

  const decision = decideMessageAction(message.remoteJid, config.mode, config.policy);
  const contextSettings = resolveConversationContext(message.remoteJid, config.policy);
  const conversationContext = getConversationContext(state, message.remoteJid, contextSettings);
  if (target && contextSettings.enabled) {
    rememberConversationEntry(state, message.remoteJid, 'inbound', message.text);
    saveRuntimeState(state);
  }

  logger.info(
    {
      target: targetLabel,
      messageId: message.id,
      action: decision.action,
      reasons: decision.reasons,
      profile: decision.profile,
      responderModel: config.responder.model,
      contextMessages: conversationContext.length
    },
    'openclaw inbound policy decision'
  );

  if (decision.action !== 'draft' && decision.action !== 'auto') {
    return { ok: true, action: decision.action, reasons: decision.reasons };
  }

  const reply = await generateDraftReply({
    remoteJid: message.remoteJid,
    text: message.text,
    policy: config.policy,
    responder: config.responder,
    conversationContext
  });

  if (decision.action === 'draft') {
    logger.info(
      {
        target: targetLabel,
        messageId: message.id,
        responderModel: config.responder.model,
        reply: logReplyContent ? reply : undefined,
        replyChars: reply.length
      },
      'draft reply ready'
    );
    return { ok: true, action: 'draft', reply };
  }

  const delivery = decideDelivery(config.policy, target);
  if (!delivery.allowed) {
    logger.warn(
      {
        target: targetLabel,
        messageId: message.id,
        responderModel: config.responder.model,
        reasons: delivery.reasons,
        reply: logReplyContent ? reply : undefined,
        replyChars: reply.length
      },
      'auto reply blocked by delivery gate'
    );
    return { ok: true, action: 'blocked', reasons: delivery.reasons, reply };
  }

  const hourlyLimit = target?.autoReply.maxRepliesPerHour ?? config.policy.maxAutoRepliesPerHour;
  const recentAutoReplies = countRecentOutbound(state, message.remoteJid, 60 * 60 * 1000);
  if (recentAutoReplies >= hourlyLimit) {
    const reasons = [`max auto replies per hour reached (${hourlyLimit})`];
    logger.warn(
      {
        target: targetLabel,
        messageId: message.id,
        responderModel: config.responder.model,
        reasons,
        reply: logReplyContent ? reply : undefined,
        replyChars: reply.length
      },
      'auto reply blocked by rate limit'
    );
    return { ok: true, action: 'blocked', reasons, reply };
  }

  logger.info(
    {
      target: targetLabel,
      messageId: message.id,
      responderModel: config.responder.model,
      reply: logReplyContent ? reply : undefined,
      replyChars: reply.length
    },
    'auto reply approved'
  );
  rememberOutbound(state, message.remoteJid, reply);
  if (target && contextSettings.enabled) {
    rememberConversationEntry(state, message.remoteJid, 'outbound', reply);
  }
  saveRuntimeState(state);
  return { ok: true, action: 'reply', reply };
}

const server = http.createServer(async (request, response) => {
  try {
    const requestPath = getRequestPath(request);

    if (request.method === 'GET' && requestPath === '/healthz') {
      try {
        const config = loadConfig();
        sendJson(response, 200, {
          ok: true,
          mode: config.mode,
          configOk: true,
          twilioOnly,
          twilioWebhookPath,
          responderModel: config.responder.model,
          responderBaseUrl: config.responder.baseUrl
        });
      } catch (error) {
        sendJson(response, 200, {
          ok: true,
          configOk: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    if (request.method === 'POST' && requestPath === '/openclaw/message') {
      if (twilioOnly) {
        sendJson(response, 404, { ok: false, error: 'not-found' });
        return;
      }

      const payload = (await readJson(request)) as InboundPayload;
      sendJson(response, 200, await handleInbound(payload));
      return;
    }

    if (request.method === 'POST' && requestPath === twilioWebhookPath) {
      const form = await readForm(request);
      if (validateTwilioSignature && !isValidTwilioSignature(request, form)) {
        logger.warn({ path: twilioWebhookPath }, 'twilio signature validation failed');
        sendXml(response, 403, buildTwilioResponse());
        return;
      }

      const result = await handleInbound(twilioFormToInboundPayload(form));
      const reply = replyFromResult(result);
      logger.info(
        {
          action: result && typeof result === 'object' && 'action' in result ? result.action : undefined,
          hasReply: Boolean(reply)
        },
        'twilio whatsapp webhook processed'
      );
      sendXml(response, 200, buildTwilioResponse(reply));
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not-found' });
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, 'inbound handler failed');
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

registerWorkerProcess();
server.listen(port, host, () => {
  logger.info(
    {
      url: `http://${host}:${port}`,
      twilioWebhookPath,
      twilioOnly,
      validateTwilioSignature,
      mode: startupConfig.mode,
      targets: startupConfig.policy.targets.map((target) => ({
        label: target.label,
        id: target.id,
        mode: target.mode,
        enabled: target.enabled
      }))
    },
    'WhatsApp inbound bridge listening'
  );
});
