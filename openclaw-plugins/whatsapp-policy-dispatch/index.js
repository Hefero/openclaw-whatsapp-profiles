import { definePluginEntry } from "openclaw/plugin-sdk/core";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8790/openclaw/message";
const DEFAULT_TIMEOUT_MS = 30000;

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

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

function resolveFirstId(...values) {
  for (const value of values) {
    const id = stringValue(value);
    if (id) {
      return id;
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
  }
});
