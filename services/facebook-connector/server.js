import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const config = {
  host: process.env.HOST || "0.0.0.0",
  port: positiveInt("PORT", 3200),
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  bin: process.env.FBCHAT_E2EE_BIN || "fbchat-bridge-e2ee",
  accountId: process.env.FACEBOOK_ACCOUNT_ID || "demo-facebook",
  token: requiredSecret("CONNECTOR_TOKEN"),
  webhookURL: requiredURL("CUSTOMER_CARE_WEBHOOK_URL"),
  channelSecret: requiredSecret("CUSTOMER_CARE_CHANNEL_SECRET"),
};

const sessionPath = path.join(config.dataDir, "session.enc.json");
const devicePath = path.join(config.dataDir, "e2ee-device.json");
const inboundOutboxPath = path.join(config.dataDir, "inbound-outbox.json");
const checkpointPath = path.join(config.dataDir, "realtime-checkpoint.json");
const outboundReceiptsPath = path.join(config.dataDir, "outbound-receipts.json");
const tmpDir = path.join(config.dataDir, "tmp");
await mkdir(tmpDir, { recursive: true });

let bridge;
let phase = "disconnected";
let profile;
let lastError;
let lastConnectedAt;
let lastMessageAt;
let nextId = 1;
let actualFacebookId = "";
let activeCookies;
let reconnectEnabled = true;
let reconnectTimer;
let reconnectAttempts = 0;
let lastDisconnectedAt;
let outboxRetryTimer;
let inboundPersistQueue = Promise.resolve();
let checkpointPersistQueue = Promise.resolve();
let outboundPersistQueue = Promise.resolve();
let inboundDeliveryQueue = Promise.resolve();
let checkpoint = { recentEventIds: [] };
const pending = new Map();
const outboundReceipts = new Map();
const outboundInFlight = new Map();
const inboundOutbox = new Map();
const recentInboundEvents = new Set();
const intentionalStops = new WeakSet();
const contactProfiles = new Map();
const peerPresence = new Map();
const presenceOfflineTimers = new Map();
const FACEBOOK_ACTIVITY_ONLINE_TTL_MS = positiveInt("FACEBOOK_ACTIVITY_ONLINE_TTL_MS", 90_000);
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
const PROFILE_ERROR_TTL_MS = 5 * 60 * 1000;

async function startBridge(cookies) {
  activeCookies = cookies;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  await stopBridge(true);
  phase = "connecting";
  lastError = undefined;

  const child = spawn(config.bin, [], { stdio: ["pipe", "pipe", "pipe"] });
  bridge = child;
  let buffer = "";
  let stderrTail = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) consumeBridgeLine(line);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const text = String(chunk || "");
    stderrTail = `${stderrTail}${text}`.slice(-8_000);
    console.warn("[facebook-bridge]", text.trim());
  });

  child.on("error", (error) => {
    // Only the currently active bridge is allowed to affect global RPC state.
    if (bridge !== child) return;
    bridge = undefined;
    const message = `Facebook bridge spawn error: ${error.message}`;
    rejectPending(new Error(message));
    phase = "error";
    lastError = message;
    console.error("[facebook][trace] bridge.spawn_error", { error: error.message });
    scheduleReconnect();
  });

  child.on("exit", (code, signal) => {
    const intentional = intentionalStops.has(child);
    const isCurrentBridge = bridge === child;

    // IMPORTANT: a bridge that was intentionally stopped can exit after the
    // replacement bridge has already started. Never let that stale process
    // reject RPCs belonging to the replacement bridge.
    if (!isCurrentBridge) {
      console.log("[facebook][trace] bridge.exit.stale", {
        code,
        signal,
        intentional,
      });
      return;
    }

    bridge = undefined;

    if (intentional) {
      console.log("[facebook][trace] bridge.exit.intentional", { code, signal });
      return;
    }

    const reason = signal
      ? `Facebook bridge exited by ${signal}`
      : `Facebook bridge exited with code ${code ?? "unknown"}`;

    rejectPending(new Error(reason));
    phase = "disconnected";
    lastError = stderrTail.trim()
      ? `${reason}: ${stderrTail.trim().slice(-2_000)}`
      : reason;
    lastDisconnectedAt = new Date().toISOString();
    checkpoint.lastDisconnectedAt = lastDisconnectedAt;
    void persistCheckpoint();

    console.warn("[facebook][trace] bridge.exit", {
      code,
      signal,
      error: lastError,
    });
    scheduleReconnect();
  });

  await rpc("newClient", { cookies, platform: "facebook", devicePath, logLevel: "warn" });
  const connected = await rpc("connect", {});
  profile = connected?.user;
  actualFacebookId = String(profile?.id || cookies.c_user || "");

  // Keep profile hydration out of the critical connection path. Customer
  // profiles are resolved lazily after E2EE is connected by
  // getFacebookContact(). A profile lookup must never prevent Messenger from
  // reaching the connected state.
  await rpc("connectE2EE", {});
  markConnected();
}

async function stopBridge(intentional = true) {
  const child = bridge;
  if (!child) return;

  if (intentional) intentionalStops.add(child);

  // Ask the bridge to shut down cleanly first. Ignore failures here because a
  // dead/hung bridge still needs to be terminated.
  try { await rpc("disconnect", {}, 5_000); } catch { }

  // Clear the active bridge before SIGTERM. The exit handler will therefore
  // recognise this process as stale/intentional and must not reject RPCs from
  // a replacement bridge.
  if (bridge === child) bridge = undefined;
  rejectPending(new Error("Facebook bridge stopped"));

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }

  // Do not start a replacement process until the previous one has had a short
  // chance to exit. This removes the old-child/new-child lifecycle race.
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

function markConnected() {
  phase = "connected";
  reconnectAttempts = 0;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  lastConnectedAt = new Date().toISOString();
  lastError = undefined;
  checkpoint.lastConnectedAt = lastConnectedAt;
  void persistCheckpoint();
  void drainInboundOutbox();
  console.log("[facebook][trace] connected", {
    accountId: actualFacebookId || config.accountId,
    pendingEvents: inboundOutbox.size,
  });
}

function scheduleReconnect(delayMs) {
  if (!reconnectEnabled || reconnectTimer || !activeCookies) return;
  let resolvedDelay = delayMs;
  if (resolvedDelay == null) {
    reconnectAttempts += 1;
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(reconnectAttempts - 1, 6));
    resolvedDelay = Math.min(60_000, base + Math.floor(base * Math.random() * 0.25));
  }
  console.log("[facebook][trace] reconnect.scheduled", {
    attempt: reconnectAttempts,
    delayMs: resolvedDelay,
  });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void startBridge(activeCookies).catch((error) => {
      phase = "error";
      lastError = error instanceof Error ? error.message : String(error);
      console.error("[facebook][trace] reconnect.failed", error);
      scheduleReconnect();
    });
  }, resolvedDelay);
  reconnectTimer.unref();
}

function rpc(method, params, timeoutMs = 30_000) {
  if (!bridge?.stdin.writable) return Promise.reject(new Error("Facebook bridge is not running"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    bridge.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function consumeBridgeLine(line) {
  let value;
  try { value = JSON.parse(line); } catch { return; }
  if (value.id) {
    const waiter = pending.get(value.id);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    pending.delete(value.id);
    value.ok ? waiter.resolve(value.data) : waiter.reject(new Error(value.error || "Bridge RPC failed"));
    return;
  }
  if (value.event) void handleBridgeEvent(value.event).catch((error) => {
    lastError = error instanceof Error ? error.message : String(error);
    console.error("[facebook] event processing failed", error);
  });
}

async function handleBridgeEvent(event) {
  if (event.type === "ready" || event.type === "e2eeConnected" || event.type === "reconnected") {
    markConnected();
    return;
  }
  if (event.type === "error") {
    lastError = event.data?.message || "Facebook bridge error";
    return;
  }
  if (event.type === "disconnected") {
    phase = "disconnected";
    lastDisconnectedAt = new Date().toISOString();
    lastError = event.data?.message || "Facebook bridge disconnected";
    checkpoint.lastDisconnectedAt = lastDisconnectedAt;
    void persistCheckpoint();
    void markFacebookPresenceUnknown();
    console.warn("[facebook][trace] disconnected", { error: lastError });
    scheduleReconnect();
    return;
  }
  if (event.type === "readReceipt") {
    await handleFacebookReadReceipt(event);
    return;
  }
  if (event.type === "e2eeReceipt") {
    await handleFacebookE2EEReceipt(event);
    return;
  }
  if (event.type !== "message" && event.type !== "e2eeMessage") return;
  const data = event.data || {};
  const messageId = String(data.id || data.messageId || "");
  if (!messageId) return;
  const threadId = String(data.threadId || String(data.chatJid || "").split("@")[0] || "");
  const senderId = String(data.senderId || String(data.senderJid || "").split("@")[0] || threadId);
  if (!threadId || !senderId) return;
  const isSelf = senderId === actualFacebookId;
  const connectorOutbound = isSelf ? findOutboundReceipt(messageId) : undefined;
  if (connectorOutbound) {
    console.log("[facebook][trace] self.echo.detected", {
      threadId,
      messageId,
      clientMessageId: connectorOutbound.clientMessageId,
    });
  }
  const threadType = Number(data.threadType) > 1 ? "group" : "user";
  const contactId = isSelf ? threadId : senderId;
  const contact = await getFacebookContact(contactId);
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const text = String(data.text || "").trim() || attachmentPlaceholder(attachments);
  if (!text) return;
  const accountId = actualFacebookId || config.accountId;
  const occurredAt = new Date(Number(data.timestampMs || event.timestamp || Date.now())).toISOString();
  if (!isSelf && threadType === "user") {
    void markFacebookPeerActive(threadId, contactId, occurredAt).catch((error) => {
      console.warn("[facebook] presence activity update failed:", error instanceof Error ? error.message : String(error));
    });
  }
  const payload = {
    event_id: `${accountId}:${isSelf ? "outgoing" : "incoming"}:message:${messageId}`,
    provider: "facebook_personal",
    account_id: accountId,
    direction: isSelf ? "outgoing" : "incoming",
    is_self: isSelf,
    external_thread_id: threadId,
    external_message_id: `${accountId}:${messageId}`,
    ...(connectorOutbound?.clientMessageId ? { client_message_id: connectorOutbound.clientMessageId } : {}),
    thread_type: threadType,
    occurred_at: occurredAt,
    sender: {
      external_id: contactId,
      display_name: String(
        (threadType === "group" ? data.threadName : contact?.name)
        || contact?.name
        || data.threadName
        || `Khách Facebook ${contactId}`,
      ),
      ...(contact?.avatarUrl ? { avatar_url: contact.avatarUrl } : {}),
    },
    message: { type: "text", text },
  };
  console.log("[facebook][trace] message.detected", {
    eventId: payload.event_id,
    direction: payload.direction,
    isSelf,
    threadId,
    messageId: payload.external_message_id,
  });
  await enqueueInbound(payload, messageId, threadId);
  lastMessageAt = occurredAt;
}

async function handleFacebookReadReceipt(event) {
  const data = event.data || {};
  const accountId = actualFacebookId || config.accountId;
  const threadId = String(data.threadId || "");
  const readerId = String(data.readerId || "");
  const watermarkMs = Number(data.readWatermarkTimestampMs || 0);
  if (!threadId || !Number.isFinite(watermarkMs) || watermarkMs <= 0) return;

  // LSMarkThreadReadV2 also emits readReceipt with ReaderID=self. That means the
  // agent read the customer's messages, not that the customer read our outgoing
  // messages, so it must not advance outbound delivery status.
  if (readerId && actualFacebookId && readerId === actualFacebookId) return;

  const occurredMs = Number(data.timestampMs || event.timestamp || Date.now());
  const occurredAt = new Date(Number.isFinite(occurredMs) ? occurredMs : Date.now()).toISOString();
  void markFacebookPeerActive(threadId, readerId || threadId, occurredAt).catch((error) => {
    console.warn("[facebook] read presence update failed:", error instanceof Error ? error.message : String(error));
  });
  const payload = {
    event_id: `${accountId}:delivery:read:${threadId}:watermark:${watermarkMs}:${readerId || "peer"}`,
    event_type: "delivery_status",
    provider: "facebook_personal",
    account_id: accountId,
    external_thread_id: threadId,
    status: "read",
    occurred_at: occurredAt,
    watermark_at: new Date(watermarkMs).toISOString(),
  };
  console.log("[facebook][trace] delivery.detected", {
    eventId: payload.event_id, status: payload.status, threadId, readerId, watermarkMs,
  });
  await enqueueInbound(payload, `watermark:${watermarkMs}`, threadId);
}

async function handleFacebookE2EEReceipt(event) {
  const data = event.data || {};
  const accountId = actualFacebookId || config.accountId;
  const receiptType = String(data.type || "").toLowerCase();
  const senderId = String(data.sender || "").split("@")[0];
  if (senderId && actualFacebookId && senderId === actualFacebookId) return;

  let status;
  if (["read", "read-self", "played", "played-self"].includes(receiptType)) status = "read";
  else if (["", "inactive"].includes(receiptType)) status = "delivered";
  else return; // retry/sender/unknown receipts are not customer delivery states.

  const threadId = String(data.chat || "").split("@")[0];
  const rawIds = [...new Set((Array.isArray(data.messageIds) ? data.messageIds : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
  if (!threadId || !rawIds.length) return;
  const externalIds = rawIds.map((id) => `${accountId}:${id}`);
  const connectorOutbound = rawIds.map((id) => findOutboundReceipt(id)).find(Boolean);
  const occurredMs = Number(event.timestamp || Date.now());
  const occurredAt = new Date(Number.isFinite(occurredMs) ? occurredMs : Date.now()).toISOString();
  if (status === "read") {
    void markFacebookPeerActive(threadId, senderId || threadId, occurredAt).catch((error) => {
      console.warn("[facebook] e2ee presence update failed:", error instanceof Error ? error.message : String(error));
    });
  }
  const payload = {
    event_id: `${accountId}:delivery:${status}:${threadId}:${rawIds.join(",")}`,
    event_type: "delivery_status",
    provider: "facebook_personal",
    account_id: accountId,
    external_thread_id: threadId,
    external_message_id: externalIds[0],
    external_message_ids: externalIds,
    ...(connectorOutbound?.clientMessageId ? { client_message_id: connectorOutbound.clientMessageId } : {}),
    status,
    occurred_at: occurredAt,
  };
  console.log("[facebook][trace] delivery.detected", {
    eventId: payload.event_id, status, threadId, externalMessageIds: externalIds, receiptType,
  });
  await enqueueInbound(payload, rawIds[0], threadId);
}

async function markFacebookPeerActive(threadId, userId, occurredAt) {
  const normalizedThreadId = String(threadId || "").trim();
  const normalizedUserId = String(userId || normalizedThreadId).trim();
  if (!normalizedThreadId || !normalizedUserId || normalizedUserId === actualFacebookId) return;

  const lastActiveAt = safeISO(occurredAt);
  const current = peerPresence.get(normalizedThreadId);
  if (!current || current.state !== "online" || current.lastActiveAt !== lastActiveAt) {
    peerPresence.set(normalizedThreadId, { state: "online", lastActiveAt });
    await enqueueFacebookPresence(normalizedThreadId, normalizedUserId, "online", lastActiveAt);
  }

  const existingTimer = presenceOfflineTimers.get(normalizedThreadId);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    presenceOfflineTimers.delete(normalizedThreadId);
    const latest = peerPresence.get(normalizedThreadId);
    if (!latest) return;
    peerPresence.set(normalizedThreadId, { state: "offline", lastActiveAt: latest.lastActiveAt });
    void enqueueFacebookPresence(normalizedThreadId, normalizedUserId, "offline", latest.lastActiveAt)
      .catch((error) => console.warn("[facebook] presence offline update failed:", error instanceof Error ? error.message : String(error)));
  }, FACEBOOK_ACTIVITY_ONLINE_TTL_MS);
  timer.unref();
  presenceOfflineTimers.set(normalizedThreadId, timer);
}

async function markFacebookPresenceUnknown() {
  for (const timer of presenceOfflineTimers.values()) clearTimeout(timer);
  presenceOfflineTimers.clear();
  const entries = [...peerPresence.entries()];
  for (const [threadId, current] of entries) {
    if (current.state === "unknown") continue;
    peerPresence.set(threadId, { state: "unknown", lastActiveAt: current.lastActiveAt });
    await enqueueFacebookPresence(threadId, threadId, "unknown", current.lastActiveAt);
  }
}

async function enqueueFacebookPresence(threadId, userId, state, lastActiveAt) {
  const accountId = actualFacebookId || config.accountId;
  const observedAt = new Date().toISOString();
  const payload = {
    event_id: `${accountId}:presence:${threadId}:${state}:${lastActiveAt || observedAt}`,
    event_type: "presence",
    provider: "facebook_personal",
    account_id: accountId,
    external_thread_id: threadId,
    external_user_id: userId,
    state,
    ...(lastActiveAt ? { last_active_at: lastActiveAt } : {}),
    observed_at: observedAt,
    source: "native_activity",
  };
  console.log("[facebook][trace] presence.detected", {
    eventId: payload.event_id,
    threadId,
    userId,
    state,
    lastActiveAt,
  });
  await enqueueInbound(payload, `presence:${userId}`, threadId);
}

function safeISO(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function getFacebookContact(userId) {
  const normalizedUserId = String(userId || "").trim();
  if (!/^\d+$/.test(normalizedUserId)) return undefined;

  const cached = contactProfiles.get(normalizedUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  console.log("[facebook][profile] lookup.start", { userId: normalizedUserId });

  try {
    const info = await rpc(
      "getUserInfo",
      { userId: Number(normalizedUserId) },
      25_000,
    );

    const value = {
      name: String(
        info?.displayName ||
        info?.name ||
        info?.firstName ||
        info?.username ||
        "",
      ).trim(),
      avatarUrl: String(
        info?.avatarUrl ||
        info?.profilePictureUrl ||
        info?.profile_picture_url ||
        info?.avatar ||
        "",
      ).trim(),
    };

    const resolved = value.name || value.avatarUrl ? value : undefined;
    contactProfiles.set(normalizedUserId, {
      profile: resolved,
      expiresAt: Date.now() + PROFILE_TTL_MS,
    });

    if (resolved) {
      console.log("[facebook][profile] lookup.ok", {
        userId: normalizedUserId,
        hasName: Boolean(resolved.name),
        hasAvatar: Boolean(resolved.avatarUrl),
      });
    } else {
      console.warn("[facebook][profile] lookup.empty", { userId: normalizedUserId });
    }

    return resolved;
  } catch (error) {
    // Cache failures only briefly so a temporary Messenger/LightSpeed problem
    // does not leave the customer with the fallback name for hours.
    contactProfiles.set(normalizedUserId, {
      profile: undefined,
      expiresAt: Date.now() + PROFILE_ERROR_TTL_MS,
    });
    console.warn("[facebook][profile] lookup.error", {
      userId: normalizedUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function pushWebhook(payload) {
  const eventType = payload.event_type;

  const targetURL =
    eventType === "delivery_status"
      ? config.webhookURL.replace(/\/events\/?$/, "/delivery")
      : eventType === "presence"
        ? config.webhookURL.replace(/\/events\/?$/, "/presence")
        : config.webhookURL;

  // event_type chỉ dùng nội bộ connector.
  // Không gửi sang Nest vì ValidationPipe có thể reject field lạ.
  const webhookPayload = {
    ...payload,
  };

  delete webhookPayload.event_type;

  // HMAC phải ký đúng raw body thực sự gửi đi.
  const body = JSON.stringify(webhookPayload);

  let error;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const timestamp = String(Date.now());

      const signature = createHmac(
        "sha256",
        config.channelSecret,
      )
        .update(`${timestamp}.${body}`)
        .digest("hex");

      console.log("[facebook][trace] webhook.request", {
        eventId: payload.event_id,
        attempt: attempt + 1,
        targetURL,
        eventType: eventType || "message",
        direction: payload.direction,
        accountId: payload.account_id,
        threadId: payload.external_thread_id,
        messageId: payload.external_message_id,
      });

      const response = await fetch(targetURL, {
        method: "POST",

        headers: {
          "content-type": "application/json",
          "x-customer-care-timestamp": timestamp,
          "x-customer-care-signature": signature,
        },

        body,

        signal: AbortSignal.timeout(20_000),
      });

      // QUAN TRỌNG:
      // đọc response kể cả khi HTTP 2xx để biết Nest đã map message
      // vào conversation/channel nào.
      const responseText = await response.text();

      let decoded;

      try {
        decoded = responseText
          ? JSON.parse(responseText)
          : {};
      } catch {
        decoded = {
          raw: responseText,
        };
      }

      console.log("[facebook][trace] webhook.response", {
        eventId: payload.event_id,
        attempt: attempt + 1,
        status: response.status,
        ok: response.ok,
        targetURL,
        response: responseText.slice(0, 1500),
      });

      if (!response.ok) {
        throw new Error(
          `Customer Care returned HTTP ${response.status}: ${responseText.slice(
            0,
            500,
          )}`,
        );
      }

      return {
        status: response.status,
        decoded,
        responseText,
      };
    } catch (reason) {
      error =
        reason instanceof Error
          ? reason
          : new Error(String(reason));

      console.error("[facebook][trace] webhook.attempt.failed", {
        eventId: payload.event_id,
        attempt: attempt + 1,
        targetURL,
        error: error.message,
      });

      /*
       * Retry:
       *
       * attempt 0 -> 1s
       * attempt 1 -> 2s
       * attempt 2 -> 4s
       * attempt 3 -> 8s
       * attempt 4 -> fail -> durable outbox retry
       */
      if (attempt < 4) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1_000 * 2 ** attempt),
        );
      }
    }
  }

  throw error;
}

// async function pushWebhook(payload) {
//   const eventType = payload.event_type;

//   const targetURL =
//     eventType === "delivery_status"
//       ? config.webhookURL.replace(/\/events\/?$/, "/delivery")
//       : eventType === "presence"
//         ? config.webhookURL.replace(/\/events\/?$/, "/presence")
//         : config.webhookURL;

//   const webhookPayload = {
//     ...payload,
//   };

//   delete webhookPayload.event_type;

//   const body = JSON.stringify(webhookPayload);

//   let error;

//   for (let attempt = 0; attempt < 5; attempt += 1) {
//     try {
//       const timestamp = String(Date.now());

//       const signature = createHmac(
//         "sha256",
//         config.channelSecret,
//       )
//         .update(`${timestamp}.${body}`)
//         .digest("hex");

//       const response = await fetch(targetURL, {
//         method: "POST",

//         headers: {
//           "content-type": "application/json",
//           "x-customer-care-timestamp": timestamp,
//           "x-customer-care-signature": signature,
//         },

//         body,

//         signal: AbortSignal.timeout(20_000),
//       });

//       if (!response.ok) {
//         const responseText = await response.text();

//         throw new Error(
//           `Customer Care returned HTTP ${response.status}: ${responseText.slice(
//             0,
//             300,
//           )}`,
//         );
//       }

//       return;
//     } catch (reason) {
//       error =
//         reason instanceof Error
//           ? reason
//           : new Error(String(reason));

//       /*
//        * Retry:
//        *
//        * attempt 0 -> 1s
//        * attempt 1 -> 2s
//        * attempt 2 -> 4s
//        * attempt 3 -> 8s
//        * attempt 4 -> 16s
//        */
//       if (attempt < 4) {
//         await new Promise((resolve) =>
//           setTimeout(resolve, 1_000 * 2 ** attempt),
//         );
//       }
//     }
//   }

//   throw error;
// }

async function enqueueInbound(payload, rawMessageId, threadId) {
  if (recentInboundEvents.has(payload.event_id)) {
    console.log("[facebook][trace] event.duplicate.skip", { eventId: payload.event_id });
    return;
  }
  if (!inboundOutbox.has(payload.event_id)) {
    inboundOutbox.set(payload.event_id, {
      eventId: payload.event_id,
      payload,
      queuedAt: new Date().toISOString(),
      attemptCount: 0,
    });
  }
  checkpoint.lastEventId = payload.event_id;
  if (payload.event_type !== "presence") {
    checkpoint.lastMessageId = rawMessageId;
    checkpoint.lastThreadId = threadId;
  }
  checkpoint.lastEventAt = payload.event_type === "presence"
    ? payload.observed_at
    : payload.occurred_at;
  await Promise.all([persistInboundOutbox(), persistCheckpoint()]);
  void drainInboundOutbox();
}

function persistInboundOutbox() {
  inboundPersistQueue = inboundPersistQueue
    .catch(() => undefined)
    .then(() => atomicWriteJSON(
      inboundOutboxPath,
      [...inboundOutbox.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)),
    ));
  return inboundPersistQueue;
}

function persistCheckpoint() {
  checkpointPersistQueue = checkpointPersistQueue
    .catch(() => undefined)
    .then(() => atomicWriteJSON(checkpointPath, checkpoint));
  return checkpointPersistQueue;
}

function persistOutboundReceipts() {
  outboundPersistQueue = outboundPersistQueue
    .catch(() => undefined)
    .then(async () => {
      const receipts = [...outboundReceipts.values()]
        .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
        .slice(0, 2_000);
      outboundReceipts.clear();
      for (const receipt of receipts) {
        outboundReceipts.set(receipt.clientMessageId, receipt);
      }
      await atomicWriteJSON(outboundReceiptsPath, receipts);
    });
  return outboundPersistQueue;
}

function drainInboundOutbox() {
  inboundDeliveryQueue = inboundDeliveryQueue
    .catch(() => undefined)
    .then(async () => {
      if (outboxRetryTimer) {
        clearTimeout(outboxRetryTimer);
        outboxRetryTimer = undefined;
      }
      const records = [...inboundOutbox.values()].sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
      let failuresThisPass = 0;

      for (const record of records) {
        // Do not let one stale/permanently-invalid native event hold the entire
        // Facebook conversation stream hostage. Missing retry metadata on old
        // outbox records intentionally means "eligible now".
        const retryAt = record.nextAttemptAt ? Date.parse(record.nextAttemptAt) : Number.NaN;
        if (Number.isFinite(retryAt) && retryAt > Date.now()) continue;

        const payload = record.payload;
        console.log("[facebook][trace] webhook.start", {
          eventId: payload.event_id,
          pendingEvents: inboundOutbox.size,
          attemptCount: record.attemptCount ?? 0,
        });
        // try {
        //   await pushWebhook(payload);
        //   inboundOutbox.delete(record.eventId);
        //   rememberProcessedEvent(record.eventId);
        //   await Promise.all([persistInboundOutbox(), persistCheckpoint()]);
        //   console.log("[facebook][trace] webhook.ok", {
        //     eventId: payload.event_id,
        //     pendingEvents: inboundOutbox.size,
        //   });
        try {
          const webhookResult = await pushWebhook(payload);

          inboundOutbox.delete(record.eventId);
          rememberProcessedEvent(record.eventId);

          await Promise.all([
            persistInboundOutbox(),
            persistCheckpoint(),
          ]);

          const decoded = webhookResult?.decoded ?? {};

          // Nest đôi khi bọc response nhiều tầng data.
          const level1 =
            decoded && typeof decoded === "object"
              ? decoded
              : {};

          const level2 =
            level1.data && typeof level1.data === "object"
              ? level1.data
              : level1;

          const level3 =
            level2.data && typeof level2.data === "object"
              ? level2.data
              : level2;

          console.log("[facebook][trace] webhook.ok", {
            eventId: payload.event_id,
            eventType: payload.event_type || "message",
            direction: payload.direction,
            threadId: payload.external_thread_id,
            messageId: payload.external_message_id,

            httpStatus: webhookResult?.status,

            conversationUuid:
              level3.conversation_uuid ||
              level2.conversation_uuid ||
              level1.conversation_uuid ||
              null,

            messageUuid:
              level3.message_uuid ||
              level2.message_uuid ||
              level1.message_uuid ||
              null,

            duplicate:
              level3.duplicate ??
              level2.duplicate ??
              level1.duplicate ??
              null,

            pendingEvents: inboundOutbox.size,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const attemptCount = (record.attemptCount ?? 0) + 1;
          const retryDelayMs = Math.min(
            5 * 60_000,
            15_000 * 2 ** Math.min(attemptCount - 1, 4),
          );
          const nextAttemptAt = new Date(Date.now() + retryDelayMs).toISOString();

          inboundOutbox.set(record.eventId, {
            ...record,
            attemptCount,
            nextAttemptAt,
            lastError: errorMessage,
          });
          await persistInboundOutbox();

          lastError = `webhook delivery failed: ${errorMessage}`;
          console.error("[facebook][trace] webhook.pending", {
            eventId: payload.event_id,
            pendingEvents: inboundOutbox.size,
            attemptCount,
            nextAttemptAt,
            error: errorMessage,
          });

          failuresThisPass += 1;
          if (failuresThisPass >= 2) break;
        }
      }

      scheduleOutboxRetry();
    });
  return inboundDeliveryQueue;
}

function rememberProcessedEvent(eventId) {
  recentInboundEvents.add(eventId);
  const recent = [eventId, ...(checkpoint.recentEventIds || []).filter((value) => value !== eventId)].slice(0, 500);
  checkpoint.recentEventIds = recent;
  const keep = new Set(recent);
  for (const value of recentInboundEvents) if (!keep.has(value)) recentInboundEvents.delete(value);
}

function scheduleOutboxRetry() {
  if (outboxRetryTimer || !inboundOutbox.size) return;

  const now = Date.now();
  let earliestEligibleAt = Number.POSITIVE_INFINITY;
  for (const record of inboundOutbox.values()) {
    const retryAt = record.nextAttemptAt ? Date.parse(record.nextAttemptAt) : Number.NaN;
    if (!Number.isFinite(retryAt)) {
      earliestEligibleAt = now;
      break;
    }
    earliestEligibleAt = Math.min(earliestEligibleAt, retryAt);
  }
  const delayMs = Number.isFinite(earliestEligibleAt)
    ? Math.max(250, Math.min(5 * 60_000, earliestEligibleAt - now))
    : 15_000;

  outboxRetryTimer = setTimeout(() => {
    outboxRetryTimer = undefined;
    void drainInboundOutbox();
  }, delayMs);
  outboxRetryTimer.unref();
}

function findOutboundReceipt(messageId) {
  const needle = String(messageId || "").trim();
  if (!needle) return undefined;
  for (const receipt of outboundReceipts.values()) {
    const externalId = String(receipt.externalMessageId || "").trim();
    if (externalId === needle || externalId.endsWith(`:${needle}`)) return receipt;
  }
  return undefined;
}

async function sendMessage(body) {
  const clientMessageId = optionalString(body.client_message_id);
  if (clientMessageId) {
    const receipt = outboundReceipts.get(clientMessageId);
    if (receipt) return { externalMessageId: receipt.externalMessageId };
    const inFlight = outboundInFlight.get(clientMessageId);
    if (inFlight) return inFlight;
  }

  const operation = sendMessageOnce(body);
  if (clientMessageId) outboundInFlight.set(clientMessageId, operation);
  try {
    const result = await operation;
    if (clientMessageId) {
      outboundReceipts.set(clientMessageId, {
        clientMessageId,
        externalMessageId: result.externalMessageId,
        sentAt: new Date().toISOString(),
      });
      await persistOutboundReceipts();
    }
    return result;
  } finally {
    if (clientMessageId) outboundInFlight.delete(clientMessageId);
  }
}

async function sendMessageOnce(body) {
  if (phase !== "connected") throw new HTTPError(409, "Facebook account is not connected");
  const threadId = requireNumeric(body.external_thread_id, "external_thread_id");
  const text = optionalString(body.text) || "";
  const attachments = parseAttachments(body.attachments);
  if (!text && !attachments.length) throw new HTTPError(400, "text or attachments is required");
  let result;
  if (text) {
    try {
      result = await rpc("sendE2EEMessage", { chatJid: `${threadId}@msgr`, text });
    } catch {
      result = await rpc("sendMessage", { threadId: Number(threadId), text, isGroup: body.thread_type === "group" });
    }
  }
  for (const attachment of attachments) {
    const filePath = path.join(tmpDir, `${Date.now()}-${randomBytes(6).toString("hex")}-${safeName(attachment.name)}`);
    await writeFile(filePath, attachment.data, { mode: 0o600 });
    try {
      const isImage = attachment.mimeType.startsWith("image/");
      const method = isImage ? "sendE2EEImage" : "sendE2EEDocument";
      const params = isImage
        ? { chatJid: `${threadId}@msgr`, imagePath: filePath, caption: text && !result ? text : "" }
        : { chatJid: `${threadId}@msgr`, filePath, fileName: attachment.name };
      result = await rpc(method, params, 60_000);
    } finally {
      await rm(filePath, { force: true });
    }
  }
  return { externalMessageId: String(result?.messageId || result?.id || "") };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "GET" && ["/health", "/status"].includes(url.pathname)) {
      return json(response, 200, status());
    }
    if (request.method === "GET" && url.pathname.startsWith("/profiles/")) {
      requireToken(request);
      const userId = requireNumeric(decodeURIComponent(url.pathname.slice("/profiles/".length)), "user_id");
      const contact = await getFacebookContact(userId);
      if (!contact) throw new HTTPError(404, "Facebook profile not found");
      return json(response, 200, contact);
    }
    if (request.method === "POST" && url.pathname === "/session") {
      requireToken(request);
      const body = await readJSON(request, 128 * 1024);
      const cookies = parseCookies(requireString(body.cookie, "cookie"));
      reconnectEnabled = true;
      activeCookies = cookies;
      await saveSession(cookies);
      try {
        await startBridge(cookies);
      } catch (error) {
        scheduleReconnect();
        throw error;
      }
      return json(response, 200, status());
    }
    if (request.method === "DELETE" && url.pathname === "/session") {
      requireToken(request);
      reconnectEnabled = false;
      activeCookies = undefined;
      reconnectAttempts = 0;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
      await stopBridge(true);
      await markFacebookPresenceUnknown();
      await Promise.all([rm(sessionPath, { force: true }), rm(devicePath, { force: true })]);
      phase = "disconnected";
      profile = undefined;
      return json(response, 200, status());
    }
    if (request.method === "POST" && url.pathname === "/messages/send") {
      requireToken(request);
      return json(response, 200, { ok: true, ...(await sendMessage(await readJSON(request, 45 * 1024 * 1024))) });
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return json(response, error instanceof HTTPError ? error.status : 500, { error: lastError });
  }
});

function status() {
  return {
    phase,
    account_id: actualFacebookId || config.accountId,
    facebook_user_id: actualFacebookId || undefined,
    profile,
    last_connected_at: lastConnectedAt,
    last_disconnected_at: lastDisconnectedAt,
    last_message_at: lastMessageAt,
    last_error: lastError,
    reconnect_attempts: reconnectAttempts,
    pending_event_count: inboundOutbox.size,
  };
}

function parseCookies(cookie) {
  const cookies = Object.fromEntries(cookie.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : [part, ""];
  }));
  for (const key of ["c_user", "xs"]) if (!cookies[key]) throw new HTTPError(400, `Facebook cookie is missing ${key}`);
  return cookies;
}

function parseAttachments(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 5) throw new HTTPError(400, "attachments must contain at most 5 files");
  return value.map((item, index) => {
    const data = Buffer.from(requireString(item?.data, `attachments[${index}].data`), "base64");
    if (!data.length || data.length > 6 * 1024 * 1024) throw new HTTPError(413, `attachments[${index}] exceeds 6 MB`);
    return { name: requireString(item?.name, `attachments[${index}].name`), mimeType: optionalString(item?.mime_type) || "application/octet-stream", data };
  });
}

async function saveSession(cookies) {
  const key = createHash("sha256").update(config.token).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(cookies), "utf8"), cipher.final()]);
  await writeFile(sessionPath, JSON.stringify({ iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }), { mode: 0o600 });
}

async function loadSession() {
  try {
    const value = JSON.parse(await readFile(sessionPath, "utf8"));
    const key = createHash("sha256").update(config.token).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, "base64")), decipher.final()]).toString("utf8"));
  } catch { return undefined; }
}


async function loadRealtimeState() {
  const storedCheckpoint = await readJSONFile(checkpointPath, { recentEventIds: [] });
  checkpoint = {
    ...storedCheckpoint,
    recentEventIds: Array.isArray(storedCheckpoint?.recentEventIds)
      ? storedCheckpoint.recentEventIds.filter((value) => typeof value === "string").slice(0, 500)
      : [],
  };
  for (const eventId of checkpoint.recentEventIds) recentInboundEvents.add(eventId);
  lastConnectedAt = optionalString(checkpoint.lastConnectedAt);
  lastDisconnectedAt = optionalString(checkpoint.lastDisconnectedAt);
  lastMessageAt = optionalString(checkpoint.lastEventAt);

  const storedOutbox = await readJSONFile(inboundOutboxPath, []);
  if (Array.isArray(storedOutbox)) {
    for (const record of storedOutbox) {
      if (!record || typeof record !== "object") continue;
      if (typeof record.eventId !== "string" || !record.payload) continue;
      inboundOutbox.set(record.eventId, {
        eventId: record.eventId,
        payload: record.payload,
        queuedAt: optionalString(record.queuedAt) || new Date().toISOString(),
        attemptCount: Number.isInteger(record.attemptCount) && record.attemptCount >= 0
          ? record.attemptCount
          : 0,
        nextAttemptAt: optionalString(record.nextAttemptAt),
        lastError: optionalString(record.lastError),
      });
    }
  }

  const storedReceipts = await readJSONFile(outboundReceiptsPath, []);
  if (Array.isArray(storedReceipts)) {
    for (const receipt of storedReceipts) {
      if (!receipt || typeof receipt !== "object") continue;
      const clientMessageId = optionalString(receipt.clientMessageId);
      if (!clientMessageId) continue;
      const normalized = {
        clientMessageId,
        externalMessageId: optionalString(receipt.externalMessageId),
        sentAt: optionalString(receipt.sentAt) || new Date().toISOString(),
      };
      outboundReceipts.set(clientMessageId, normalized);
    }
  }
}

async function readJSONFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(`[facebook] cannot read ${path.basename(filePath)}:`, error instanceof Error ? error.message : String(error));
    }
    return fallback;
  }
}

async function atomicWriteJSON(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

function readJSON(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => { size += chunk.length; if (size > limit) { reject(new HTTPError(413, "Request body is too large")); request.destroy(); } else chunks.push(chunk); });
    request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new HTTPError(400, "Invalid JSON")); } });
    request.on("error", reject);
  });
}

function requireToken(request) { if (request.headers["x-facebook-connector-token"] !== config.token) throw new HTTPError(401, "Invalid connector token"); }
function requiredSecret(name) { const value = process.env[name]?.trim() || ""; if (value.length < 24) throw new Error(`${name} must contain at least 24 characters`); return value; }
function requiredURL(name) { const value = process.env[name]?.trim() || ""; if (!/^https?:\/\//.test(value)) throw new Error(`${name} must be an http/https URL`); return value; }
function positiveInt(name, fallback) { const value = Number(process.env[name] || fallback); if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be positive`); return value; }
function requireString(value, name) { if (typeof value !== "string" || !value.trim()) throw new HTTPError(400, `${name} is required`); return value.trim(); }
function requireNumeric(value, name) { const result = requireString(value, name); if (!/^\d+$/.test(result)) throw new HTTPError(400, `${name} must be numeric`); return result; }
function optionalString(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function safeName(value) { return value.replace(/[^a-z0-9._-]/gi, "_").slice(-120) || "file.bin"; }
function attachmentPlaceholder(items) { if (!items.length) return ""; return items.some((item) => item?.type === "image") ? "[Hình ảnh]" : "[Tệp đính kèm]"; }
function rejectPending(error) { for (const waiter of pending.values()) { clearTimeout(waiter.timeout); waiter.reject(error); } pending.clear(); }
function json(response, statusCode, value) { response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
class HTTPError extends Error { constructor(status, message) { super(message); this.status = status; } }

await loadRealtimeState();
if (inboundOutbox.size) void drainInboundOutbox();
const stored = await loadSession();
if (stored) {
  activeCookies = stored;
  void startBridge(stored).catch((error) => {
    phase = "error";
    lastError = error instanceof Error ? error.message : String(error);
    console.error("[facebook] auto-login failed", error);
    scheduleReconnect();
  });
}
server.listen(config.port, config.host, () => console.log(`[facebook-connector] listening on ${config.host}:${config.port}`));
