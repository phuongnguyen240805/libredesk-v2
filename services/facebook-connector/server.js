import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const pending = new Map();
const knownOutbound = new Set();
const contactProfiles = new Map();
const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
const PROFILE_ERROR_TTL_MS = 5 * 60 * 1000;

async function startBridge(cookies) {
  await stopBridge();
  phase = "connecting";
  lastError = undefined;
  bridge = spawn(config.bin, [], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  bridge.stdout.setEncoding("utf8");
  bridge.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) consumeBridgeLine(line);
    }
  });
  bridge.stderr.setEncoding("utf8");
  bridge.stderr.on("data", (chunk) => console.warn("[facebook-bridge]", chunk.trim()));
  bridge.on("exit", (code) => {
    rejectPending(new Error(`Facebook bridge exited (${code ?? "unknown"})`));
    bridge = undefined;
    if (phase !== "disconnected") phase = "error";
  });

  await rpc("newClient", { cookies, platform: "facebook", devicePath, logLevel: "warn" });
  const connected = await rpc("connect", {});
  profile = connected?.user;
  actualFacebookId = String(profile?.id || cookies.c_user || "");
  await rpc("connectE2EE", {});
  phase = "connected";
  lastConnectedAt = new Date().toISOString();
}

async function stopBridge() {
  if (!bridge) return;
  try { await rpc("disconnect", {}, 5_000); } catch {}
  bridge.kill("SIGTERM");
  bridge = undefined;
  rejectPending(new Error("Facebook bridge stopped"));
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
    phase = "connected";
    lastConnectedAt = new Date().toISOString();
    return;
  }
  if (event.type === "error" || event.type === "disconnected") {
    lastError = event.data?.message || "Facebook bridge disconnected";
    if (event.type === "disconnected") phase = "disconnected";
    return;
  }
  if (event.type !== "message" && event.type !== "e2eeMessage") return;
  const data = event.data || {};
  const messageId = String(data.id || data.messageId || "");
  if (!messageId || knownOutbound.delete(messageId)) return;
  const threadId = String(data.threadId || String(data.chatJid || "").split("@")[0] || "");
  const senderId = String(data.senderId || String(data.senderJid || "").split("@")[0] || threadId);
  if (!threadId || !senderId) return;
  const isSelf = senderId === actualFacebookId;
  const threadType = Number(data.threadType) > 1 ? "group" : "user";
  const contactId = isSelf ? threadId : senderId;
  const contact = await getFacebookContact(contactId);
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const text = String(data.text || "").trim() || attachmentPlaceholder(attachments);
  if (!text) return;
  const accountId = actualFacebookId || config.accountId;
  const payload = {
    event_id: `${accountId}:${isSelf ? "outgoing" : "incoming"}:message:${messageId}`,
    provider: "facebook_personal",
    account_id: accountId,
    direction: isSelf ? "outgoing" : "incoming",
    is_self: isSelf,
    external_thread_id: threadId,
    external_message_id: `${accountId}:${messageId}`,
    thread_type: threadType,
    occurred_at: new Date(Number(data.timestampMs || event.timestamp || Date.now())).toISOString(),
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
  await pushWebhook(payload);
  lastMessageAt = new Date().toISOString();
}

async function getFacebookContact(userId) {
  if (!/^\d+$/.test(userId)) return undefined;
  const cached = contactProfiles.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  try {
    const info = await rpc("getUserInfo", { userId: Number(userId) }, 15_000);
    const value = {
      name: String(info?.name || info?.firstName || "").trim(),
      avatarUrl: String(info?.profilePictureUrl || "").trim(),
    };
    const resolved = value.name || value.avatarUrl ? value : undefined;
    contactProfiles.set(userId, { profile: resolved, expiresAt: Date.now() + PROFILE_TTL_MS });
    return resolved;
  } catch (error) {
    contactProfiles.set(userId, { profile: undefined, expiresAt: Date.now() + PROFILE_ERROR_TTL_MS });
    console.warn(`[facebook] unable to resolve profile ${userId}:`, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

async function pushWebhook(payload) {
  const body = JSON.stringify(payload);
  let error;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const timestamp = String(Date.now());
      const signature = createHmac("sha256", config.channelSecret).update(`${timestamp}.${body}`).digest("hex");
      const response = await fetch(config.webhookURL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-customer-care-timestamp": timestamp, "x-customer-care-signature": signature },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Customer Care returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return;
    } catch (reason) {
      error = reason;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
  }
  throw error;
}

async function sendMessage(body) {
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
  const externalMessageId = String(result?.messageId || result?.id || "");
  if (externalMessageId) knownOutbound.add(externalMessageId);
  return { externalMessageId };
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
      await saveSession(cookies);
      await startBridge(cookies);
      return json(response, 200, status());
    }
    if (request.method === "DELETE" && url.pathname === "/session") {
      requireToken(request);
      await stopBridge();
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
  return { phase, account_id: actualFacebookId || config.accountId, facebook_user_id: actualFacebookId || undefined, profile, last_connected_at: lastConnectedAt, last_message_at: lastMessageAt, last_error: lastError };
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

const stored = await loadSession();
if (stored) void startBridge(stored).catch((error) => { phase = "error"; lastError = error.message; console.error("[facebook] auto-login failed", error); });
server.listen(config.port, config.host, () => console.log(`[facebook-connector] listening on ${config.host}:${config.port}`));
