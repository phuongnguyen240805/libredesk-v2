import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3200);
const token = required("CONNECTOR_TOKEN");
const masterSecret = required("CUSTOMER_CARE_WEBHOOK_SECRET");
const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const webhookBase = required("CUSTOMER_CARE_WEBHOOK_URL")
  .replace(/\/(?:zalo\/)?events\/?$/, "")
  .replace(/\/$/, "");
const sessions = new Map();

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/health") return json(response, 200, { ok: true, sessions: sessions.size });
    requireToken(request);
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const match = url.pathname.match(/^\/sessions\/([0-9a-f-]{36})(?:\/(status|profiles\/[^/]+|messages\/send))?$/i);
    if (!match) return json(response, 404, { error: "Not found" });
    const connectionKey = match[1];
    const child = await ensureSession(connectionKey);
    const suffix = match[2];
    const targetPath = suffix === "status" ? "/status"
      : suffix?.startsWith("profiles/") ? `/${suffix}`
      : suffix === "messages/send" ? "/messages/send"
      : "/session";
    const body = await readBody(request, 45 * 1024 * 1024);
    const upstream = await fetch(`http://127.0.0.1:${child.port}${targetPath}${url.search}`, {
      method: request.method,
      headers: {
        "content-type": request.headers["content-type"] || "application/json",
        "x-facebook-connector-token": token,
      },
      body: ["GET", "HEAD"].includes(request.method || "GET") ? undefined : body,
      signal: AbortSignal.timeout(90_000),
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    });
    response.end(bytes);
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

async function ensureSession(connectionKey) {
  const current = sessions.get(connectionKey);
  if (current) return current;
  const childPort = await reservePort();
  const channelSecret = createHmac("sha256", masterSecret)
    .update(`customer-care-channel:${connectionKey}`)
    .digest("hex");
  const processHandle = spawn(process.execPath, [path.join(root, "server.js")], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(childPort),
      DATA_DIR: path.join(dataDir, "sessions", connectionKey),
      FACEBOOK_ACCOUNT_ID: `pending:${connectionKey}`,
      CUSTOMER_CARE_WEBHOOK_URL: `${webhookBase}/channels/${connectionKey}/events`,
      CUSTOMER_CARE_CHANNEL_SECRET: channelSecret,
    },
    windowsHide: true,
  });
  const session = { port: childPort, process: processHandle };
  sessions.set(connectionKey, session);
  processHandle.once("exit", () => sessions.delete(connectionKey));
  await waitForHealth(childPort, processHandle);
  return session;
}

async function reservePort() {
  return new Promise((resolve, reject) => {
    const socket = createNetServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      const selected = typeof address === "object" && address ? address.port : 0;
      socket.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

async function waitForHealth(childPort, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Facebook session worker exited (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${childPort}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  throw new Error("Facebook session worker did not start");
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) reject(new Error("Request body is too large"));
      else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function required(name) {
  const value = process.env[name]?.trim() || "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function requireToken(request) {
  if (request.headers["x-facebook-connector-token"] !== token) throw new Error("Invalid connector token");
}
function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

server.listen(port, host, () => console.log(`[facebook-supervisor] listening on ${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  for (const session of sessions.values()) session.process.kill("SIGTERM");
  process.exit(0);
});
