import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  LoginQRCallbackEventType,
  ThreadType,
  Zalo,
} from "zca-js";
import type { API, Credentials, Message } from "zca-js";
import { pushInboundToCustomerCare } from "./customer-care.js";
import {
  clearCredentials,
  ensureDataDir,
  loadCredentials,
  loadOutboundReceipts,
  saveCredentials,
  saveOutboundReceipts,
  type OutboundReceipt,
} from "./storage.js";

export type ConnectorPhase =
  | "starting"
  | "qr_ready"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface ConnectorStatus {
  phase: ConnectorPhase;
  account_id: string;
  profile?: unknown;
  last_connected_at?: string;
  last_message_at?: string;
  last_error?: string;
  qr_available: boolean;
}

type CachedProfile = { displayName: string; avatarUrl: string; expiresAt: number };
type OutboundAttachment = { name: string; mimeType: string; data: Buffer };
export interface ZaloManagerOptions {
  connectionKey: string;
  dataDir: string;
  webhookURL: string;
  webhookSecret: string;
  retryCount: number;
  retryBaseMs: number;
}

export class ZaloManager {
  private api?: API;
  private phase: ConnectorPhase = "starting";
  private profile?: unknown;
  private lastConnectedAt?: string;
  private lastMessageAt?: string;
  private lastError?: string;
  private connecting = false;
  private reconnectEnabled = true;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly profileCache = new Map<string, CachedProfile>();
  private readonly outboundReceipts = new Map<string, OutboundReceipt>();
  private readonly outboundInFlight = new Map<string, Promise<{ externalMessageId?: string }>>();
  private outboundPersistQueue: Promise<void> = Promise.resolve();
  private accountId: string;
  private readonly qrPath: string;

  constructor(private readonly options: ZaloManagerOptions) {
    this.accountId = `pending:${options.connectionKey}`;
    this.qrPath = path.join(options.dataDir, "qr.png");
  }

  async initialize(): Promise<void> {
    await ensureDataDir(this.options.dataDir);
    for (const receipt of await loadOutboundReceipts(this.options.dataDir)) {
      this.outboundReceipts.set(receipt.clientMessageId, receipt);
    }
    void this.connect();
  }

  getStatus(): ConnectorStatus {
    return {
      phase: this.phase,
      account_id: this.accountId,
      profile: toJSONSafe(this.profile),
      last_connected_at: this.lastConnectedAt,
      last_message_at: this.lastMessageAt,
      last_error: this.lastError,
      qr_available: this.phase === "qr_ready" && existsSync(this.qrPath),
    };
  }

  getQRPath(): string {
    return this.qrPath;
  }

  isConnected(): boolean {
    return this.phase === "connected" && Boolean(this.api);
  }

  async sendMessage(input: {
    externalThreadId: string;
    threadType: "user" | "group";
    text: string;
    attachments?: OutboundAttachment[];
    clientMessageId?: string;
  }): Promise<{ externalMessageId?: string }> {
    const key = input.clientMessageId?.trim();
    if (key) {
      const receipt = this.outboundReceipts.get(key);
      if (receipt) return { externalMessageId: receipt.externalMessageId };
      const inFlight = this.outboundInFlight.get(key);
      if (inFlight) return inFlight;
    }

    const operation = this.sendMessageOnce(input);
    if (key) this.outboundInFlight.set(key, operation);
    try {
      const result = await operation;
      if (key) {
        this.outboundReceipts.set(key, {
          clientMessageId: key,
          externalMessageId: result.externalMessageId,
          sentAt: new Date().toISOString(),
        });
        await this.persistOutboundReceipts();
      }
      return result;
    } finally {
      if (key) this.outboundInFlight.delete(key);
    }
  }

  private async sendMessageOnce(input: {
    externalThreadId: string;
    threadType: "user" | "group";
    text: string;
    attachments?: OutboundAttachment[];
  }): Promise<{ externalMessageId?: string }> {
    if (!this.api || !this.isConnected()) {
      throw new Error("Zalo account is not connected");
    }

    const threadType = input.threadType === "group" ? ThreadType.Group : ThreadType.User;
    const attachments = input.attachments?.map((attachment) => ({
      data: attachment.data,
      filename: ensureFileExtension(attachment.name, attachment.mimeType),
      metadata: { totalSize: attachment.data.length },
    }));
    const result = await this.api.sendMessage(
      { msg: input.text, ...(attachments?.length ? { attachments } : {}) },
      input.externalThreadId,
      threadType,
    );
    return { externalMessageId: extractMessageId(result) };
  }

  private persistOutboundReceipts(): Promise<void> {
    this.outboundPersistQueue = this.outboundPersistQueue
      .catch(() => undefined)
      .then(async () => {
        const receipts = [...this.outboundReceipts.values()]
          .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
          .slice(0, 2_000);
        this.outboundReceipts.clear();
        for (const receipt of receipts) {
          this.outboundReceipts.set(receipt.clientMessageId, receipt);
        }
        await saveOutboundReceipts(this.options.dataDir, receipts);
      });
    return this.outboundPersistQueue;
  }

  async resetSession(): Promise<void> {
    await this.disconnectSession();
    this.reconnectEnabled = true;
    this.scheduleReconnect(250);
  }

  async disconnectSession(): Promise<void> {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;

    const api = this.api;
    this.api = undefined;
    try {
      api?.listener.stop();
    } catch (error) {
      console.warn("[zalo] listener stop during disconnect failed:", error);
    }

    await clearCredentials(this.options.dataDir);
    this.profile = undefined;
    this.profileCache.clear();
    this.phase = "disconnected";
    this.lastError = undefined;
    await fs.rm(this.qrPath, { force: true });
  }

  private async connect(): Promise<void> {
    if (!this.reconnectEnabled || this.connecting || this.isConnected()) return;
    this.connecting = true;
    this.lastError = undefined;
    this.phase = "connecting";

    try {
      // Native messages sent from the logged-in Zalo client are required for
      // Customer Care to stay in sync with conversations started outside UI.
      const zalo = new Zalo({ selfListen: true });
      const credentials = await loadCredentials(this.options.dataDir);
      let api: API;

      if (credentials) {
        api = await zalo.login(credentials);
      } else {
        api = await zalo.loginQR(
          { qrPath: this.qrPath },
          (event) => {
            switch (event.type) {
              case LoginQRCallbackEventType.QRCodeGenerated:
                void event.actions.saveToFile(this.qrPath)
                  .then(() => {
                    this.phase = "qr_ready";
                    this.lastError = undefined;
                    console.log(`[zalo] QR saved at ${this.qrPath}`);
                  })
                  .catch((error: unknown) => {
                    this.phase = "error";
                    this.lastError = error instanceof Error ? error.message : String(error);
                    console.error("[zalo] failed to save QR:", error);
                  });
                break;
              case LoginQRCallbackEventType.QRCodeScanned:
                this.phase = "connecting";
                console.log(`[zalo] QR scanned by ${event.data.display_name}`);
                void fs.rm(this.qrPath, { force: true });
                break;
              case LoginQRCallbackEventType.QRCodeExpired:
              case LoginQRCallbackEventType.QRCodeDeclined:
                this.phase = "connecting";
                void fs.rm(this.qrPath, { force: true }).finally(() => event.actions.retry());
                break;
              case LoginQRCallbackEventType.GotLoginInfo:
                this.phase = "connecting";
                break;
            }
          },
        );
        await this.persistCredentials(api);
        await fs.rm(this.qrPath, { force: true });
      }

      this.api = api;
      this.registerListener(api);
      this.profile = await api.fetchAccountInfo().catch((error: unknown) => ({
        warning: error instanceof Error ? error.message : String(error),
      }));
      const profileRecord = this.profile && typeof this.profile === "object"
        ? this.profile as Record<string, unknown>
        : {};
      this.accountId = stringValue(profileRecord.uid) || stringValue(profileRecord.id) || this.accountId;

      api.listener.start({ retryOnClose: true });
    } catch (error) {
      this.api = undefined;
      this.phase = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("[zalo] connection failed:", error);
      this.scheduleReconnect(10_000);
    } finally {
      this.connecting = false;
    }
  }

  private registerListener(api: API): void {
    api.listener.on("message", async (event) => {
      try {
        await this.handleIncomingMessage(event);
      } catch (error) {
        console.error("[zalo] inbound message processing failed:", error);
      }
    });

    api.listener.on("connected", () => {
      this.phase = "connected";
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = undefined;
      void fs.rm(this.qrPath, { force: true });
      console.log("[zalo] listener connected");
    });

    api.listener.on("disconnected", (code, reason) => {
      this.phase = "disconnected";
      this.lastError = `socket disconnected (${code})${reason ? `: ${reason}` : ""}`;
      console.warn("[zalo] listener disconnected", { code, reason });
    });

    api.listener.on("closed", (code, reason) => {
      if (this.api === api) this.api = undefined;
      this.phase = "disconnected";
      this.lastError = `socket closed (${code})${reason ? `: ${reason}` : ""}`;
      if (this.reconnectEnabled) {
        console.warn("[zalo] listener closed; scheduling reconnect", { code, reason });
        this.scheduleReconnect(5_000);
      }
    });

    api.listener.on("error", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("[zalo] listener error:", error);
    });
  }

  private async handleIncomingMessage(event: Message): Promise<void> {
    if (typeof event.data.content !== "string") return;

    const text = event.data.content.trim();
    if (!text) return;

    const isSelf = Boolean(event.isSelf);
    const direction: "incoming" | "outgoing" = isSelf ? "outgoing" : "incoming";
    const threadType: "user" | "group" =
      event.type === ThreadType.Group ? "group" : "user";

    const externalThreadId = String(event.threadId);
    const rawMessageId = String(
      event.data.msgId ||
        event.data.cliMsgId ||
        `${externalThreadId}-${event.data.ts || Date.now()}`,
    );

    // A message sent from the CSKH UI is already persisted by Nest/LibreDesk.
    // zca-js can echo that same outgoing message back through the listener.
    // Skip the echo to avoid duplicate/loop.
    if (isSelf && this.isKnownConnectorOutbound(rawMessageId)) {
      console.log("[zalo][trace] self.echo.skip", {
        threadId: externalThreadId,
        messageId: rawMessageId,
      });
      return;
    }

    const externalMessageId = `${this.accountId}:${rawMessageId}`;

    // For a direct chat:
    // - incoming: uidFrom is the customer
    // - outgoing/self: threadId is the peer/customer
    const peerExternalId =
      threadType === "user"
        ? isSelf
          ? externalThreadId
          : String(event.data.uidFrom || externalThreadId)
        : String(event.data.uidFrom || externalThreadId);

    const eventDisplayName =
      typeof event.data.dName === "string" ? event.data.dName.trim() : "";

    // Profile lookup is enrichment only. getUserProfile() already catches
    // DNS/API failures and returns an empty fallback.
    const profile =
      threadType === "user"
        ? await this.getUserProfile(peerExternalId)
        : { displayName: "", avatarUrl: "" };

    const displayName =
      profile.displayName ||
      eventDisplayName ||
      (threadType === "group"
        ? `Nhóm Zalo ${externalThreadId}`
        : `Khách Zalo ${peerExternalId}`);

    const payload = {
      event_id: `${this.accountId}:${direction}:message:${rawMessageId}`,
      provider: "zalo_personal" as const,
      account_id: this.accountId,
      direction,
      is_self: isSelf,
      external_thread_id: externalThreadId,
      external_message_id: externalMessageId,
      thread_type: threadType,
      occurred_at: normalizeOccurredAt(event.data.ts),
      sender: {
        // For native outgoing messages this intentionally describes the peer,
        // so Nest can resolve the existing CSKH contact/conversation.
        external_id: peerExternalId,
        display_name: displayName,
        avatar_url: profile.avatarUrl || undefined,
      },
      message: {
        type: "text" as const,
        text,
      },
    };

    console.log("[zalo][trace] message.detected", {
      eventId: payload.event_id,
      direction,
      isSelf,
      threadId: externalThreadId,
      messageId: externalMessageId,
      peerId: peerExternalId,
    });

    console.log("[zalo][trace] webhook.start", {
      eventId: payload.event_id,
    });

    try {
      const result = await pushInboundToCustomerCare(payload, {
        connectionKey: this.options.connectionKey,
        dataDir: this.options.dataDir,
        webhookURL: this.options.webhookURL,
        webhookSecret: this.options.webhookSecret,
        retryCount: this.options.retryCount,
        retryBaseMs: this.options.retryBaseMs,
      });
      console.log("[zalo][trace] webhook.ok", {
        eventId: payload.event_id,
        conversationUuid: result.conversation_uuid,
        messageUuid: result.message_uuid,
      });
      this.lastMessageAt = new Date().toISOString();
    } catch (error) {
      console.error("[zalo][trace] webhook.failed", {
        eventId: payload.event_id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private isKnownConnectorOutbound(rawMessageId: string): boolean {
    const needle = String(rawMessageId).trim();
    if (!needle) return false;

    for (const receipt of this.outboundReceipts.values()) {
      const id = String(receipt.externalMessageId || "").trim();
      if (!id) continue;
      if (id === needle || id.endsWith(`:${needle}`)) return true;
    }
    return false;
  }

  private async getUserProfile(userId: string): Promise<{ displayName: string; avatarUrl: string }> {
    const cached = this.profileCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const fallback = { displayName: "", avatarUrl: "" };
    if (!this.api) return fallback;
    try {
      const response = await this.api.getUserInfo(userId) as unknown as Record<string, unknown>;
      const changedProfiles = response.changed_profiles && typeof response.changed_profiles === "object"
        ? response.changed_profiles as Record<string, Record<string, unknown>>
        : {};
      const profile = changedProfiles[userId] || Object.values(changedProfiles)[0] || response;
      const value = {
        displayName: stringValue(profile.displayName) || stringValue(profile.zaloName) || "",
        avatarUrl: stringValue(profile.avatar) || "",
        expiresAt: Date.now() + 30 * 60_000,
      };
      this.profileCache.set(userId, value);
      return value;
    } catch (error) {
      console.warn(`[zalo] cannot get profile for ${userId}:`, error);
      return fallback;
    }
  }

  private async persistCredentials(api: API): Promise<void> {
    const context = api.getContext();
    const credentials: Credentials = {
      cookie: context.cookie.toJSON()?.cookies ?? [],
      imei: context.imei,
      userAgent: context.userAgent,
    };
    await saveCredentials(this.options.dataDir, credentials);
  }

  private scheduleReconnect(delayMs: number): void {
    if (!this.reconnectEnabled) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delayMs);
    this.reconnectTimer.unref();
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractMessageId(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = extractMessageId(item);
      if (id) return id;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = record.msgId || record.messageId || record.cliMsgId;
  return id == null ? undefined : String(id);
}

function ensureFileExtension(name: string, mimeType: string): `${string}.${string}` {
  if (/\.[a-z0-9]{1,10}$/i.test(name)) return name as `${string}.${string}`;
  const extension = mimeType.split("/")[1]?.split(/[;+]/)[0]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return `${name}.${extension}`;
}

function normalizeOccurredAt(value: unknown): string {
  if (typeof value === "number") {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeOccurredAt(numeric);
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

function toJSONSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)) as unknown;
  } catch {
    return { warning: "profile could not be serialized" };
  }
}
