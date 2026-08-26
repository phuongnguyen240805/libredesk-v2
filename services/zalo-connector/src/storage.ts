import fs from "node:fs/promises";
import path from "node:path";
import type { Credentials } from "zca-js";

export interface OutboundReceipt {
  clientMessageId: string;
  externalMessageId?: string;
  sentAt: string;
}

export interface PendingInboundRecord {
  eventId: string;
  payload: unknown;
  queuedAt: string;
  /** Number of failed deliveries. Optional for backward compatibility with old outbox files. */
  attemptCount?: number;
  /** ISO timestamp after which this record is eligible for another delivery attempt. */
  nextAttemptAt?: string;
  /** Last delivery error, persisted only for diagnostics. */
  lastError?: string;
}

export interface RealtimeCheckpoint {
  lastEventId?: string;
  lastMessageId?: string;
  lastThreadId?: string;
  lastEventAt?: string;
  lastConnectedAt?: string;
  lastDisconnectedAt?: string;
  recentEventIds: string[];
}

export async function ensureDataDir(dataDir: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
}

export async function loadCredentials(dataDir: string): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(path.join(dataDir, "credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (!Array.isArray(parsed.cookie) || !parsed.imei || !parsed.userAgent) {
      return null;
    }
    return parsed as Credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveCredentials(dataDir: string, credentials: Credentials): Promise<void> {
  await atomicWrite(path.join(dataDir, "credentials.json"), JSON.stringify(credentials, null, 2));
}

export async function clearCredentials(dataDir: string): Promise<void> {
  await fs.rm(path.join(dataDir, "credentials.json"), { force: true });
}


export async function loadOutboundReceipts(dataDir: string): Promise<OutboundReceipt[]> {
  try {
    const raw = await fs.readFile(path.join(dataDir, "outbound-receipts.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is OutboundReceipt =>
      Boolean(value) &&
      typeof value === "object" &&
      typeof (value as OutboundReceipt).clientMessageId === "string" &&
      typeof (value as OutboundReceipt).sentAt === "string"
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveOutboundReceipts(dataDir: string, receipts: OutboundReceipt[]): Promise<void> {
  await atomicWrite(path.join(dataDir, "outbound-receipts.json"), JSON.stringify(receipts, null, 2));
}

export async function appendDeadLetter(dataDir: string, payload: unknown, error: unknown): Promise<void> {
  const line = JSON.stringify({
    failed_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
    payload,
  });
  await fs.appendFile(path.join(dataDir, "dead-letter.jsonl"), `${line}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function loadInboundOutbox(dataDir: string): Promise<PendingInboundRecord[]> {
  try {
    const raw = await fs.readFile(path.join(dataDir, "inbound-outbox.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is PendingInboundRecord =>
      Boolean(value) &&
      typeof value === "object" &&
      typeof (value as PendingInboundRecord).eventId === "string" &&
      typeof (value as PendingInboundRecord).queuedAt === "string" &&
      "payload" in (value as object)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveInboundOutbox(dataDir: string, records: PendingInboundRecord[]): Promise<void> {
  await atomicWrite(path.join(dataDir, "inbound-outbox.json"), JSON.stringify(records, null, 2));
}

export async function loadRealtimeCheckpoint(dataDir: string): Promise<RealtimeCheckpoint> {
  try {
    const raw = await fs.readFile(path.join(dataDir, "realtime-checkpoint.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<RealtimeCheckpoint>;
    return {
      ...parsed,
      recentEventIds: Array.isArray(parsed.recentEventIds)
        ? parsed.recentEventIds.filter((value): value is string => typeof value === "string").slice(0, 500)
        : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { recentEventIds: [] };
    throw error;
  }
}

export async function saveRealtimeCheckpoint(dataDir: string, checkpoint: RealtimeCheckpoint): Promise<void> {
  await atomicWrite(path.join(dataDir, "realtime-checkpoint.json"), JSON.stringify(checkpoint, null, 2));
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
}
