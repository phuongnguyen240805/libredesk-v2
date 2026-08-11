import fs from "node:fs/promises";
import path from "node:path";
import type { Credentials } from "zca-js";

export interface OutboundReceipt {
  clientMessageId: string;
  externalMessageId?: string;
  sentAt: string;
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

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, filePath);
}
