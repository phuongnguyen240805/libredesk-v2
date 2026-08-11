import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { config } from "./config.js";
import { ZaloManager } from "./zalo-manager.js";

const managers = new Map<string, Promise<ZaloManager>>();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const match = url.pathname.match(/^\/sessions\/([0-9a-f-]{36})(?:\/(status|qr|reset|messages\/send))?$/i);

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJSON(response, 200, { ok: true, sessions: managers.size });
    }

    if (match && request.method === "GET" && match[2] === "status") {
      requireToken(request);
      const manager = await getManager(match[1]);
      return sendJSON(response, 200, manager.getStatus());
    }

    if (match && request.method === "GET" && match[2] === "qr") {
      requireToken(request);
      const manager = await getManager(match[1]);
      const qrPath = manager.getQRPath();
      if (!fs.existsSync(qrPath)) {
        return sendJSON(response, 404, {
          error: "QR is not available. Check /status; a saved session may already be connected.",
        });
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
      fs.createReadStream(qrPath).pipe(response);
      return;
    }

    if (match && request.method === "POST" && match[2] === "messages/send") {
      requireToken(request);
      const manager = await getManager(match[1]);
      const body = await readJSON(request);
      const accountId = requireString(body.account_id, "account_id");
      if (accountId !== manager.getStatus().account_id) throw new HTTPError(409, "The message belongs to another Zalo account");
      const externalThreadId = requireString(body.external_thread_id, "external_thread_id");
      const text = optionalString(body.text) ?? "";
      const attachments = parseAttachments(body.attachments);
      if (!text && attachments.length === 0) throw new HTTPError(400, "text or attachments is required");
      const clientMessageId = optionalString(body.client_message_id);
      const threadType = body.thread_type === "group" ? "group" : "user";
      const result = await manager.sendMessage({ externalThreadId, threadType, text, attachments, clientMessageId });
      return sendJSON(response, 200, { ok: true, ...result });
    }

    if (match && request.method === "POST" && match[2] === "reset") {
      requireToken(request);
      const manager = await getManager(match[1]);
      await manager.resetSession();
      return sendJSON(response, 202, { ok: true, message: "Session cleared; a new QR will be generated." });
    }

    if (match && request.method === "DELETE" && !match[2]) {
      requireToken(request);
      const manager = await getManager(match[1]);
      await manager.disconnectSession();
      managers.delete(match[1]);
      return sendJSON(response, 200, { ok: true, message: "Zalo session disconnected and credentials cleared." });
    }

    return sendJSON(response, 404, { error: "Not found" });
  } catch (error) {
    const status = error instanceof HTTPError ? error.status : 500;
    console.error("[http] request failed:", error);
    return sendJSON(response, status, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

function getManager(connectionKey: string): Promise<ZaloManager> {
  const existing = managers.get(connectionKey);
  if (existing) return existing;
  const operation = (async () => {
    const manager = new ZaloManager({
      connectionKey,
      dataDir: path.join(config.dataDir, "sessions", connectionKey),
      webhookURL: config.customerCareWebhookURL,
      webhookSecret: config.customerCareWebhookSecret,
      retryCount: config.inboundRetryCount,
      retryBaseMs: config.inboundRetryBaseMs,
    });
    await manager.initialize();
    return manager;
  })().catch((error) => {
    managers.delete(connectionKey);
    throw error;
  });
  managers.set(connectionKey, operation);
  return operation;
}

server.listen(config.port, config.host, () => {
  console.log(`[connector] listening on http://${config.host}:${config.port}`);
  console.log(`[connector] status: http://127.0.0.1:${config.port}/status`);
  console.log(`[connector] QR: http://127.0.0.1:${config.port}/qr`);
});

function requireToken(request: http.IncomingMessage): void {
  const token = request.headers["x-zalo-connector-token"];
  if (typeof token !== "string" || token !== config.connectorToken) {
    throw new HTTPError(401, "Invalid connector token");
  }
}

async function readJSON(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 45 * 1024 * 1024) throw new HTTPError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new HTTPError(400, `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseAttachments(value: unknown) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 5) throw new HTTPError(400, "attachments must contain at most 5 files");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HTTPError(400, `attachments[${index}] is invalid`);
    }
    const record = item as Record<string, unknown>;
    const name = requireString(record.name, `attachments[${index}].name`);
    const data = requireString(record.data, `attachments[${index}].data`);
    const buffer = Buffer.from(data, "base64");
    if (!buffer.length || buffer.length > 6 * 1024 * 1024) {
      throw new HTTPError(413, `attachments[${index}] must be between 1 byte and 6 MB`);
    }
    return {
      name,
      mimeType: optionalString(record.mime_type) ?? "application/octet-stream",
      data: buffer,
    };
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HTTPError(400, `${name} is required`);
  }
  return value.trim();
}

function sendJSON(response: http.ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}

class HTTPError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
