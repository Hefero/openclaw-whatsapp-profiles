import { definePluginEntry } from "openclaw/plugin-sdk/core";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8790/openclaw/message";
const FALLBACK_TIMEOUT_MS = 120000;
const DEFAULT_TYPING_INTERVAL_MS = 7000;

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
  const endpoint =
    stringValue(pluginConfig.endpoint) ||
    stringValue(process.env.WHATSAPP_ASSISTANT_HOOK_URL) ||
    DEFAULT_ENDPOINT;
  return {
    enabled: pluginConfig.enabled !== false,
    endpoint,
    typingPolicyEndpoint:
      stringValue(pluginConfig.typingPolicyEndpoint) ||
      resolveSiblingEndpoint(endpoint, "/openclaw/typing-policy"),
    timeoutMs: numberValue(pluginConfig.timeoutMs, DEFAULT_TIMEOUT_MS)
  };
}

function resolveSiblingEndpoint(endpoint, pathname) {
  try {
    const url = new URL(endpoint);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return endpoint.replace(/\/openclaw\/message(?:\?.*)?$/u, pathname);
  }
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
    resolveCtxString(msgCtx, "RawBody") ||
    resolveCtxString(msgCtx, "Body") ||
    transcript ||
    resolveCtxString(msgCtx, "BodyForAgent") ||
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

function normalizeTypingPolicy(body) {
  const raw = isObject(body?.typing) ? body.typing : body;
  if (!isObject(raw)) {
    return { enabled: false, intervalMs: DEFAULT_TYPING_INTERVAL_MS };
  }

  return {
    enabled: raw.enabled === true,
    intervalMs: numberValue(raw.intervalMs, DEFAULT_TYPING_INTERVAL_MS)
  };
}

async function resolveTypingPolicy(config, payload, api) {
  try {
    const { response, body } = await postToWorker(config.typingPolicyEndpoint, config.timeoutMs, payload);
    if (!response.ok) {
      api.logger.warn?.(
        `whatsapp-policy-dispatch: typing policy returned HTTP ${response.status}, skipping typing indicator`
      );
      return { enabled: false, intervalMs: DEFAULT_TYPING_INTERVAL_MS };
    }

    return normalizeTypingPolicy(body);
  } catch (error) {
    api.logger.debug?.(
      `whatsapp-policy-dispatch: typing policy unavailable, skipping typing indicator: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { enabled: false, intervalMs: DEFAULT_TYPING_INTERVAL_MS };
  }
}

function startTypingIndicator(ctx, typing, api) {
  if (!typing.enabled || typeof ctx?.onReplyStart !== "function") {
    return () => {};
  }

  let stopped = false;
  let inFlight = false;
  const intervalMs = numberValue(typing.intervalMs, DEFAULT_TYPING_INTERVAL_MS);
  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }

    inFlight = true;
    try {
      await ctx.onReplyStart();
    } catch (error) {
      api.logger.debug?.(
        `whatsapp-policy-dispatch: typing indicator failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
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
        typingPolicyEndpoint: { type: "string" },
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

      return;
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
      const hasContent = stringValue(payload.context?.content);
      if (!hasMedia && !hasContent) {
        ctx.recordProcessed?.("completed", { reason: "whatsapp-policy-dispatch-empty-message" });
        ctx.markIdle?.("message_completed");
        return { handled: true, queuedFinal: false, counts: ctx.dispatcher.getQueuedCounts() };
      }

      const typing = await resolveTypingPolicy(config, payload, api);
      const stopTypingIndicator = startTypingIndicator(ctx, typing, api);

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
      } finally {
        stopTypingIndicator();
      }
    }, { timeoutMs: DEFAULT_TIMEOUT_MS });
  }
});
