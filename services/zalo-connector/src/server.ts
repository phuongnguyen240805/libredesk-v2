import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { config } from "./config.js";
import { ZaloManager } from "./zalo-manager.js";

const managers = new Map<string, Promise<ZaloManager>>();

// Some zca-js QR retry callbacks reject outside the loginQR promise even
// though each manager already handles its own connection failure. Keep one
// expired QR session from terminating every connected tenant session.
process.on("unhandledRejection", (error) => {
  console.error("[connector] unhandled async operation:", error);
});

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    const match = url.pathname.match(
      /^\/sessions\/([0-9a-f-]{36})(?:\/(status|qr|reset|adopt|messages\/send))?$/i,
    );
    const connectionKey = match?.[1];
    const action = match?.[2];

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJSON(response, 200, { ok: true, sessions: managers.size });
    }

    if (connectionKey && request.method === "GET" && action === "status") {
      requireToken(request);
      const manager = await getManager(connectionKey);
      return sendJSON(response, 200, manager.getStatus());
    }

    if (connectionKey && request.method === "GET" && action === "qr") {
      requireToken(request);
      const manager = await getManager(connectionKey);
      const qrPath = manager.getQRPath();
      if (!fs.existsSync(qrPath)) {
        return sendJSON(response, 404, {
          error:
            "QR is not available. Check /status; a saved session may already be connected.",
        });
      }
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
      fs.createReadStream(qrPath).pipe(response);
      return;
    }

    if (
      connectionKey &&
      request.method === "POST" &&
      action === "messages/send"
    ) {
      requireToken(request);
      const manager = await getManager(connectionKey);
      const body = await readJSON(request);
      const accountId = requireString(body.account_id, "account_id");
      if (accountId !== manager.getStatus().account_id)
        throw new HTTPError(409, "The message belongs to another Zalo account");
      const externalThreadId = requireString(
        body.external_thread_id,
        "external_thread_id",
      );
      const text = optionalString(body.text) ?? "";
      const attachments = parseAttachments(body.attachments);
      if (!text && attachments.length === 0)
        throw new HTTPError(400, "text or attachments is required");
      const clientMessageId = optionalString(body.client_message_id);
      const threadType = body.thread_type === "group" ? "group" : "user";
      const result = await manager.sendMessage({
        externalThreadId,
        threadType,
        text,
        attachments,
        clientMessageId,
      });
      return sendJSON(response, 200, { ok: true, ...result });
    }

    if (connectionKey && request.method === "POST" && action === "reset") {
      requireToken(request);
      const manager = await getManager(connectionKey);
      await manager.resetSession();
      return sendJSON(response, 202, {
        ok: true,
        message: "Session cleared; a new QR will be generated.",
      });
    }

    if (connectionKey && request.method === "POST" && action === "adopt") {
      requireToken(request);
      const body = await readJSON(request);
      const targetConnectionKey = requireUUID(
        body.target_connection_key,
        "target_connection_key",
      );
      if (targetConnectionKey === connectionKey) {
        throw new HTTPError(400, "Source and target sessions must be different");
      }
      const status = await adoptSession(connectionKey, targetConnectionKey);
      return sendJSON(response, 200, { ok: true, ...status });
    }

    if (connectionKey && request.method === "DELETE" && !action) {
      requireToken(request);

      const manager = await getManager(connectionKey);

      await manager.disconnectSession();
      managers.delete(connectionKey);
      return sendJSON(response, 200, {
        ok: true,
        message: "Zalo session disconnected and credentials cleared.",
      });
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

async function adoptSession(sourceKey: string, targetKey: string) {
  const source = await getManager(sourceKey);
  if (!source.isConnected()) {
    throw new HTTPError(409, "Source Zalo session is not connected");
  }

  const existingTarget = managers.get(targetKey);
  if (existingTarget) {
    await (await existingTarget).disconnectSession();
    managers.delete(targetKey);
  }

  const sourceDir = path.join(config.dataDir, "sessions", sourceKey);
  const targetDir = path.join(config.dataDir, "sessions", targetKey);
  await fs.promises.rm(targetDir, { recursive: true, force: true });
  await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.promises.cp(sourceDir, targetDir, { recursive: true });

  await source.disconnectSession();
  managers.delete(sourceKey);
  await fs.promises.rm(sourceDir, { recursive: true, force: true });

  const target = await getManager(targetKey);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = target.getStatus();
    if (status.phase === "connected") return status;
    if (status.phase === "error") {
      throw new HTTPError(502, status.last_error || "Adopted Zalo session failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new HTTPError(504, "Adopted Zalo session did not reconnect in time");
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

async function readJSON(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 45 * 1024 * 1024)
      throw new HTTPError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(
      Buffer.concat(chunks).toString("utf8") || "{}",
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new HTTPError(
      400,
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseAttachments(value: unknown) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 5)
    throw new HTTPError(400, "attachments must contain at most 5 files");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HTTPError(400, `attachments[${index}] is invalid`);
    }
    const record = item as Record<string, unknown>;
    const name = requireString(record.name, `attachments[${index}].name`);
    const data = requireString(record.data, `attachments[${index}].data`);
    const buffer = Buffer.from(data, "base64");
    if (!buffer.length || buffer.length > 6 * 1024 * 1024) {
      throw new HTTPError(
        413,
        `attachments[${index}] must be between 1 byte and 6 MB`,
      );
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

function requireUUID(value: unknown, name: string): string {
  const result = requireString(value, name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new HTTPError(400, `${name} must be a UUID`);
  }
  return result;
}

function sendJSON(
  response: http.ServerResponse,
  status: number,
  data: unknown,
): void {
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
