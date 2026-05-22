import { definePluginEntry } from "openclaw/plugin-sdk/core";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8790/openclaw/message";
const FALLBACK_TIMEOUT_MS = 120000;

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value, fallback) {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

const DEFAULT_TIMEOUT_MS = numberValue(
  process.env.WHATSAPP_ASSISTANT_DISPATCH_TIMEOUT_MS,
  FALLBACK_TIMEOUT_MS
);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveConfig(api) {
  const pluginConfig = isObject(api.pluginConfig) ? api.pluginConfig : {};
  return {
    enabled: pluginConfig.enabled !== false,
    endpoint:
      stringValue(pluginConfig.endpoint) ||
      stringValue(process.env.WHATSAPP_ASSISTANT_HOOK_URL) ||
      DEFAULT_ENDPOINT,
    timeoutMs: numberValue(pluginConfig.timeoutMs, DEFAULT_TIMEOUT_MS)
  };
}

function resolveContent(event) {
  return stringValue(event?.content) || stringValue(event?.body);
}

function isMediaPlaceholder(value) {
  return /^<media:[a-z0-9_-]+>$/i.test(stringValue(value));
}

function shouldDeferToReplyDispatch(event) {
  return isMediaPlaceholder(event?.content) || isMediaPlaceholder(event?.body);
}

function resolveFirstId(...values) {
  for (const value of values) {
    const id = stringValue(value);
    if (id) {
      return id;
    }
  }

  return "";
}

function firstStringFromArray(value) {
  return Array.isArray(value) ? value.find((item) => typeof item === "string" && item.trim()) ?? "" : "";
}

function resolveCtxString(ctx, ...keys) {
  for (const key of keys) {
    const value = stringValue(ctx?.[key]) || firstStringFromArray(ctx?.[key]);
    if (value) {
      return value;
    }
  }

  return "";
}

function isGroupId(value) {
  return stringValue(value).endsWith("@g.us");
}

function resolveGroupIdFromSessionKey(sessionKey) {
  const key = stringValue(sessionKey);
  const match = key.match(/(?:^|:)group:([^:]+@g\.us)(?:$|:)/);
  return match?.[1] ?? "";
}

function resolveGroupId(...values) {
  for (const value of values) {
    const id = stringValue(value);
    if (isGroupId(id)) {
      return id;
    }
  }

  return "";
}

function buildWorkerPayload(event, ctx, content) {
  const senderId = resolveFirstId(ctx?.senderId, event?.senderId);
  const openclawConversationId = resolveFirstId(ctx?.conversationId, event?.conversationId);
  const sessionKey = resolveFirstId(ctx?.sessionKey, event?.sessionKey);
  const sessionGroupId = resolveGroupIdFromSessionKey(sessionKey);
  const groupId = resolveGroupId(
    ctx?.conversationId,
    event?.conversationId,
    ctx?.chatId,
    event?.chatId,
    ctx?.remoteJid,
    event?.remoteJid,
    sessionGroupId
  );
  const isGroup = event?.isGroup === true || Boolean(groupId);
  const conversationId = isGroup ? groupId || openclawConversationId : resolveFirstId(senderId, openclawConversationId);
  const from = resolveFirstId(conversationId, senderId, sessionKey);
  const timestamp = typeof event?.timestamp === "number" ? event.timestamp : Date.now();

  return {
    type: "message",
    action: "received",
    sessionKey,
    timestamp,
    context: {
      from,
      content,
      channelId: "whatsapp",
      metadata: {
        senderId,
        conversationId,
        chatId: conversationId,
        remoteJid: conversationId,
        from,
        openclawConversationId,
        accountId: resolveFirstId(ctx?.accountId),
        isGroup
      }
    }
  };
}

function resolveReplyDispatchChannel(ctx) {
  return resolveFirstId(ctx?.OriginatingChannel, ctx?.Provider, ctx?.Surface);
}

function buildWorkerPayloadFromReplyDispatch(event) {
  const msgCtx = event?.ctx ?? {};
  const channelId = resolveReplyDispatchChannel(msgCtx);
  const sessionKey = resolveCtxString(msgCtx, "SessionKey");
  const senderId = resolveFirstId(
    msgCtx.SenderId,
    msgCtx.SenderE164,
    msgCtx.From
  );
  const mediaPath = resolveCtxString(msgCtx, "MediaPath", "MediaPaths");
  const mediaUrl = resolveCtxString(msgCtx, "MediaUrl", "MediaUrls");
  const mediaType = resolveCtxString(msgCtx, "MediaType", "MediaTypes");
  const mediaFileName = resolveCtxString(msgCtx, "MediaFileName", "FileName");
  const transcript = resolveCtxString(msgCtx, "Transcript");
  const sessionGroupId = resolveGroupIdFromSessionKey(sessionKey);
  const groupId = resolveGroupId(
    msgCtx.OriginatingTo,
    msgCtx.To,
    msgCtx.ConversationId,
    msgCtx.GroupId,
    sessionGroupId
  );
  const isGroup =
    msgCtx.ChatType === "group" ||
    Boolean(msgCtx.GroupSubject || msgCtx.GroupChannel || groupId);
  const openclawConversationId = resolveFirstId(
    msgCtx.OriginatingTo,
    msgCtx.To,
    msgCtx.From
  );
  const conversationId = isGroup ? groupId || openclawConversationId : resolveFirstId(senderId, openclawConversationId);
  const content =
    resolveCtxString(msgCtx, "BodyForAgent") ||
    resolveCtxString(msgCtx, "RawBody") ||
    resolveCtxString(msgCtx, "Body") ||
    transcript ||
    (mediaType.startsWith("audio/") ? "<media:audio>" : "");
  const timestamp = typeof msgCtx.Timestamp === "number" ? msgCtx.Timestamp : Date.now();

  return {
    type: "message",
    action: "received",
    sessionKey,
    timestamp,
    context: {
      from: resolveFirstId(conversationId, senderId, sessionKey),
      content,
      channelId,
      metadata: {
        senderId,
        conversationId,
        chatId: conversationId,
        remoteJid: conversationId,
        from: resolveFirstId(conversationId, senderId, sessionKey),
        openclawConversationId,
        accountId: resolveCtxString(msgCtx, "AccountId"),
        isGroup,
        messageId: resolveCtxString(msgCtx, "MessageSidFull", "MessageSid", "MessageSidFirst", "MessageSidLast"),
        mediaPath,
        mediaUrl,
        mediaType,
        mediaFileName,
        transcript
      }
    }
  };
}

async function postToWorker(endpoint, timeoutMs, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const bodyText = await response.text();
    let body = {};
    if (bodyText.trim()) {
      body = JSON.parse(bodyText);
    }

    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
}

function resultToDispatch(result) {
  if (result?.action === "reply" && typeof result.reply === "string" && result.reply.trim()) {
    return { handled: true, text: result.reply.trim() };
  }

  if (
    result?.action === "draft" ||
    result?.action === "manual" ||
    result?.action === "ignored" ||
    result?.action === "blocked"
  ) {
    return { handled: true };
  }

  return { handled: true };
}

export default definePluginEntry({
  id: "whatsapp-policy-dispatch",
  name: "WhatsApp Policy Dispatch",
  description:
    "Routes WhatsApp inbound messages through the local whatsapp-chatbot policy worker before OpenClaw starts a native agent run.",
  configSchema: {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        endpoint: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  register(api) {
    api.on("before_dispatch", async (event, ctx) => {
      const channelId = stringValue(ctx?.channelId) || stringValue(event?.channel);
      if (channelId !== "whatsapp") {
        return;
      }

      const config = resolveConfig(api);
      if (!config.enabled) {
        return { handled: true };
      }

      if (shouldDeferToReplyDispatch(event)) {
        return;
      }

      const content = resolveContent(event);
      if (!content) {
        return { handled: true };
      }

      const payload = buildWorkerPayload(event, ctx, content);

      try {
        const { response, body } = await postToWorker(config.endpoint, config.timeoutMs, payload);
        if (!response.ok) {
          api.logger.warn?.(
            `whatsapp-policy-dispatch: worker returned HTTP ${response.status}, suppressing native reply`
          );
          return { handled: true };
        }

        api.logger.info?.(
          `whatsapp-policy-dispatch: worker action=${stringValue(body?.action) || "unknown"} target=${stringValue(payload.context?.from) || "unknown"}`
        );
        return resultToDispatch(body);
      } catch (error) {
        api.logger.error?.(
          `whatsapp-policy-dispatch: worker call failed, suppressing native reply: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return { handled: true };
      }
    }, { timeoutMs: DEFAULT_TIMEOUT_MS });

    api.on("reply_dispatch", async (event, ctx) => {
      const msgCtx = event?.ctx ?? {};
      const channelId = resolveReplyDispatchChannel(msgCtx);
      if (channelId !== "whatsapp") {
        return;
      }

      const config = resolveConfig(api);
      if (!config.enabled) {
        return { handled: true, queuedFinal: false, counts: ctx.dispatcher.getQueuedCounts() };
      }

      const payload = buildWorkerPayloadFromReplyDispatch(event);
      const hasMedia =
        stringValue(payload.context?.metadata?.mediaPath) ||
        stringValue(payload.context?.metadata?.mediaUrl) ||
        stringValue(payload.context?.metadata?.mediaType);
      if (!hasMedia) {
        return;
      }

      try {
        const { response, body } = await postToWorker(config.endpoint, config.timeoutMs, payload);
        if (!response.ok) {
          api.logger.warn?.(
            `whatsapp-policy-dispatch: worker returned HTTP ${response.status}, suppressing native reply`
          );
          ctx.recordProcessed?.("completed", { reason: "whatsapp-policy-dispatch-worker-http-error" });
          ctx.markIdle?.("message_completed");
          return { handled: true, queuedFinal: false, counts: ctx.dispatcher.getQueuedCounts() };
        }

        let queuedFinal = false;
        if (body?.action === "reply" && typeof body.reply === "string" && body.reply.trim()) {
          queuedFinal = ctx.dispatcher.sendFinalReply({ text: body.reply.trim() });
        }

        api.logger.info?.(
          `whatsapp-policy-dispatch: worker action=${stringValue(body?.action) || "unknown"} target=${stringValue(payload.context?.from) || "unknown"}`
        );
        ctx.recordProcessed?.("completed", { reason: "whatsapp-policy-dispatch" });
        ctx.markIdle?.("message_completed");
        return { handled: true, queuedFinal, counts: ctx.dispatcher.getQueuedCounts() };
      } catch (error) {
        api.logger.error?.(
          `whatsapp-policy-dispatch: worker call failed, suppressing native reply: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        ctx.recordProcessed?.("completed", { reason: "whatsapp-policy-dispatch-worker-error" });
        ctx.markIdle?.("message_completed");
        return { handled: true, queuedFinal: false, counts: ctx.dispatcher.getQueuedCounts() };
      }
    }, { timeoutMs: DEFAULT_TIMEOUT_MS });
  }
});
