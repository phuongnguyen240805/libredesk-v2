import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { LoginQRCallbackEventType, ThreadType, Zalo } from "zca-js";
import type { API, Credentials, Message } from "zca-js";
import {
  pushDeliveryStatusToCustomerCare,
  pushInboundToCustomerCare,
  pushPresenceToCustomerCare,
  type CustomerCareConnectorEvent,
  type NormalizedDeliveryStatus,
  type NormalizedPresenceStatus,
  type NormalizedZaloInbound,
} from "./customer-care.js";
import {
  clearCredentials,
  ensureDataDir,
  loadCredentials,
  loadInboundOutbox,
  loadOutboundReceipts,
  loadRealtimeCheckpoint,
  saveCredentials,
  saveInboundOutbox,
  saveOutboundReceipts,
  saveRealtimeCheckpoint,
  type OutboundReceipt,
  type PendingInboundRecord,
  type RealtimeCheckpoint,
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
  last_disconnected_at?: string;
  last_message_at?: string;
  last_error?: string;
  reconnect_attempts: number;
  pending_event_count: number;
  qr_available: boolean;
}

type CachedProfile = {
  displayName: string;
  avatarUrl: string;
  expiresAt: number;
};
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
  private lastDisconnectedAt?: string;
  private lastMessageAt?: string;
  private lastError?: string;
  private connecting = false;
  private reconnectEnabled = true;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private outboxRetryTimer?: NodeJS.Timeout;
  private readonly profileCache = new Map<string, CachedProfile>();
  private readonly profileLookupInFlight = new Map<
    string,
    Promise<{ displayName: string; avatarUrl: string }>
  >();
  private readonly presencePeers = new Set<string>();
  private readonly presenceSignatures = new Map<string, string>();
  private presenceTimer?: NodeJS.Timeout;
  private readonly outboundReceipts = new Map<string, OutboundReceipt>();
  private readonly outboundInFlight = new Map<
    string,
    Promise<{ externalMessageId?: string }>
  >();
  private readonly inboundOutbox = new Map<string, PendingInboundRecord>();
  private readonly recentInboundEvents = new Set<string>();
  private outboundPersistQueue: Promise<void> = Promise.resolve();
  private inboundPersistQueue: Promise<void> = Promise.resolve();
  private checkpointPersistQueue: Promise<void> = Promise.resolve();
  private inboundDeliveryQueue: Promise<void> = Promise.resolve();
  private checkpoint: RealtimeCheckpoint = { recentEventIds: [] };
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
    this.checkpoint = await loadRealtimeCheckpoint(this.options.dataDir);
    for (const eventId of this.checkpoint.recentEventIds) {
      this.recentInboundEvents.add(eventId);
    }
    this.lastConnectedAt = this.checkpoint.lastConnectedAt;
    this.lastDisconnectedAt = this.checkpoint.lastDisconnectedAt;
    this.lastMessageAt = this.checkpoint.lastEventAt;
    for (const record of await loadInboundOutbox(this.options.dataDir)) {
      this.inboundOutbox.set(record.eventId, record);
    }
    if (this.inboundOutbox.size) void this.drainInboundOutbox();
    void this.connect();
  }

  getStatus(): ConnectorStatus {
    return {
      phase: this.phase,
      account_id: this.accountId,
      profile: toJSONSafe(this.profile),
      last_connected_at: this.lastConnectedAt,
      last_disconnected_at: this.lastDisconnectedAt,
      last_message_at: this.lastMessageAt,
      last_error: this.lastError,
      reconnect_attempts: this.reconnectAttempts,
      pending_event_count: this.inboundOutbox.size,
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

    const threadType =
      input.threadType === "group" ? ThreadType.Group : ThreadType.User;
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
    this.reconnectAttempts = 0;

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
    this.profileLookupInFlight.clear();
    await this.markTrackedPresenceUnknown();
    this.presencePeers.clear();
    this.presenceSignatures.clear();
    this.stopPresencePolling();
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
        api = await zalo.loginQR({ qrPath: this.qrPath }, (event) => {
          switch (event.type) {
            case LoginQRCallbackEventType.QRCodeGenerated:
              void event.actions
                .saveToFile(this.qrPath)
                .then(() => {
                  this.phase = "qr_ready";
                  this.lastError = undefined;
                  console.log(`[zalo] QR saved at ${this.qrPath}`);
                })
                .catch((error: unknown) => {
                  this.phase = "error";
                  this.lastError =
                    error instanceof Error ? error.message : String(error);
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
              // zca-js may reject retry() when QR polling already expired.
              // Consume that rejection so it cannot restart the connector.
              void fs
                .rm(this.qrPath, { force: true })
                .then(() => event.actions.retry())
                .catch((error: unknown) => {
                  this.lastError =
                    error instanceof Error ? error.message : String(error);
                  console.warn("[zalo] QR retry failed:", error);
                });
              break;
            case LoginQRCallbackEventType.GotLoginInfo:
              this.phase = "connecting";
              break;
          }
        });
        await this.persistCredentials(api);
        await fs.rm(this.qrPath, { force: true });
      }

      this.api = api;
      this.registerListener(api);

      // fetchAccountInfo() returns { profile: User }. Normalize the logged-in
      // account profile at the connector boundary so every consumer gets one
      // stable shape. In particular, zca-js exposes the account image as
      // profile.avatar while the CSKH frontend consumes profile.avatarUrl.
      const fetchedProfile = await api
        .fetchAccountInfo()
        .catch((error: unknown) => ({
          warning: error instanceof Error ? error.message : String(error),
        }));
      const profileRecord =
        fetchedProfile && typeof fetchedProfile === "object"
          ? (fetchedProfile as Record<string, unknown>)
          : {};
      const accountProfile =
        profileRecord.profile && typeof profileRecord.profile === "object"
          ? (profileRecord.profile as Record<string, unknown>)
          : profileRecord;

      // fetchAccountInfo() identifies the logged-in account with userId.
      this.accountId =
        stringValue(accountProfile.userId) ||
        stringValue(accountProfile.uid) ||
        stringValue(accountProfile.id) ||
        stringValue(accountProfile.globalId) ||
        this.accountId;

      const accountAvatar =
        stringValue(accountProfile.avatar) ||
        stringValue(accountProfile.avatarUrl) ||
        stringValue(accountProfile.avatar_url);
      const accountDisplayName =
        stringValue(accountProfile.displayName) ||
        stringValue(accountProfile.zaloName) ||
        stringValue(accountProfile.username);

      this.profile = {
        ...accountProfile,
        userId: this.accountId,
        ...(accountDisplayName ? { displayName: accountDisplayName } : {}),
        ...(accountAvatar
          ? { avatar: accountAvatar, avatarUrl: accountAvatar }
          : {}),
      };

      console.log("[zalo][trace] account.profile", {
        accountId: this.accountId,
        displayName: accountDisplayName || undefined,
        hasAvatar: Boolean(accountAvatar),
      });

      api.listener.start({ retryOnClose: true });
    } catch (error) {
      this.api = undefined;
      this.phase = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("[zalo] connection failed:", error);
      this.scheduleReconnect();
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

    // zca-js 2.1.2 exposes native delivery/read receipts. They are sent through
    // the same durable connector outbox as messages, but to a dedicated Nest DTO.
    api.listener.on("delivered_messages", (messages) => {
      for (const receipt of messages) {
        void this.handleDeliveryReceipt(receipt, "delivered").catch((error) => {
          console.error("[zalo] delivered receipt processing failed:", error);
        });
      }
    });

    api.listener.on("seen_messages", (messages) => {
      for (const receipt of messages) {
        void this.handleDeliveryReceipt(receipt, "read").catch((error) => {
          console.error("[zalo] seen receipt processing failed:", error);
        });
      }
    });

    api.listener.on("connected", () => {
      this.phase = "connected";
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = undefined;
      this.checkpoint.lastConnectedAt = this.lastConnectedAt;
      void this.persistCheckpoint();
      void fs.rm(this.qrPath, { force: true });
      void this.drainInboundOutbox();
      this.startPresencePolling();
      console.log("[zalo][trace] listener.connected", {
        accountId: this.accountId,
        pendingEvents: this.inboundOutbox.size,
      });
    });

    api.listener.on("disconnected", (code, reason) => {
      this.phase = "disconnected";
      this.lastDisconnectedAt = new Date().toISOString();
      this.lastError = `socket disconnected (${code})${reason ? `: ${reason}` : ""}`;
      this.checkpoint.lastDisconnectedAt = this.lastDisconnectedAt;
      void this.persistCheckpoint();
      this.stopPresencePolling();
      void this.markTrackedPresenceUnknown();
      console.warn("[zalo][trace] listener.disconnected", { code, reason });
    });

    api.listener.on("closed", (code, reason) => {
      if (this.api === api) this.api = undefined;
      this.phase = "disconnected";
      this.lastDisconnectedAt = new Date().toISOString();
      this.lastError = `socket closed (${code})${reason ? `: ${reason}` : ""}`;
      this.checkpoint.lastDisconnectedAt = this.lastDisconnectedAt;
      void this.persistCheckpoint();
      this.stopPresencePolling();
      void this.markTrackedPresenceUnknown();
      if (this.reconnectEnabled) {
        console.warn("[zalo][trace] listener.closed", { code, reason });
        this.scheduleReconnect();
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

    // Keep connector-originated self echoes instead of dropping them. The
    // client_message_id lets Nest reconcile the native ACK with the optimistic
    // CSKH message exactly; self messages sent from the Zalo app have no receipt
    // and are therefore inserted as real outgoing conversation events.
    const connectorOutbound = isSelf
      ? this.findConnectorOutbound(rawMessageId)
      : undefined;
    if (connectorOutbound) {
      console.log("[zalo][trace] self.echo.detected", {
        threadId: externalThreadId,
        messageId: rawMessageId,
        clientMessageId: connectorOutbound.clientMessageId,
      });
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

    if (threadType === "user") {
      this.trackPresencePeer(peerExternalId);
    }

    const eventDisplayName =
      typeof event.data.dName === "string" ? event.data.dName.trim() : "";

    // Keep customer profile enrichment off the realtime hot path. A cache hit is
    // free; a cache miss gets only a tiny budget so a slow Zalo getUserInfo()
    // cannot hold the message for seconds. The lookup continues in background.
    const profile =
      threadType === "user"
        ? await this.getUserProfileFast(
            peerExternalId,
            eventDisplayName ? 0 : 120,
          )
        : { displayName: "", avatarUrl: "" };

    const displayName =
      profile.displayName ||
      eventDisplayName ||
      (threadType === "group"
        ? `Nhóm Zalo ${externalThreadId}`
        : `Khách Zalo ${peerExternalId}`);

    const payload: NormalizedZaloInbound = {
      event_id: `${this.accountId}:${direction}:message:${rawMessageId}`,
      provider: "zalo_personal" as const,
      account_id: this.accountId,
      direction,
      is_self: isSelf,
      external_thread_id: externalThreadId,
      external_message_id: externalMessageId,
      ...(connectorOutbound?.clientMessageId
        ? { client_message_id: connectorOutbound.clientMessageId }
        : {}),
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

    await this.enqueueInbound(payload, rawMessageId, externalThreadId);
    this.lastMessageAt = payload.occurred_at;
  }

  private async handleDeliveryReceipt(
    receipt: unknown,
    status: "delivered" | "read",
  ): Promise<void> {
    if (!receipt || typeof receipt !== "object") return;
    const record = receipt as Record<string, unknown>;
    const data =
      record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>)
        : {};
    const threadId =
      stringValue(record.threadId) ||
      stringValue(data.groupId) ||
      stringValue(data.idTo);
    if (!threadId) return;
    if (!stringValue(data.groupId)) this.trackPresencePeer(threadId);

    // Zalo receipts may expose both msgId and realMsgId. Keep both because the
    // send ACK and listener echo can use different native IDs depending on chat type.
    const rawIds = [
      ...new Set(
        [stringValue(data.realMsgId), stringValue(data.msgId)].filter(Boolean),
      ),
    ];

    const primaryRawId = rawIds[0];
    if (!primaryRawId) return;
    const externalIds = rawIds.map((id) => `${this.accountId}:${id}`);
    const connectorOutbound = rawIds
      .map((id) => this.findConnectorOutbound(id))
      .find((value): value is OutboundReceipt => Boolean(value));
    const occurredAt = normalizeOccurredAt(data.mSTs ?? Date.now());
    const payload: NormalizedDeliveryStatus = {
      event_id: `${this.accountId}:delivery:${status}:${threadId}:${rawIds.join(",")}`,
      event_type: "delivery_status",
      provider: "zalo_personal",
      account_id: this.accountId,
      external_thread_id: threadId,
      external_message_id: externalIds[0],
      external_message_ids: externalIds,
      ...(connectorOutbound?.clientMessageId
        ? { client_message_id: connectorOutbound.clientMessageId }
        : {}),
      status,
      occurred_at: occurredAt,
    };

    console.log("[zalo][trace] delivery.detected", {
      eventId: payload.event_id,
      status,
      threadId,
      externalMessageIds: externalIds,
    });
    await this.enqueueInbound(payload, primaryRawId, threadId);
  }

  private findConnectorOutbound(
    rawMessageId: string,
  ): OutboundReceipt | undefined {
    const needle = String(rawMessageId).trim();
    if (!needle) return undefined;

    for (const receipt of this.outboundReceipts.values()) {
      const id = String(receipt.externalMessageId || "").trim();
      if (!id) continue;
      if (id === needle || id.endsWith(`:${needle}`)) return receipt;
    }
    return undefined;
  }

  private async enqueueInbound(
    payload: CustomerCareConnectorEvent,
    rawMessageId: string,
    threadId: string,
  ): Promise<void> {
    if (this.recentInboundEvents.has(payload.event_id)) {
      console.log("[zalo][trace] event.duplicate.skip", {
        eventId: payload.event_id,
      });
      return;
    }

    if (!this.inboundOutbox.has(payload.event_id)) {
      this.inboundOutbox.set(payload.event_id, {
        eventId: payload.event_id,
        payload,
        queuedAt: new Date().toISOString(),
      });
    }

    this.checkpoint.lastEventId = payload.event_id;
    if (!("event_type" in payload && payload.event_type === "presence")) {
      this.checkpoint.lastMessageId = rawMessageId;
      this.checkpoint.lastThreadId = threadId;
    }
    this.checkpoint.lastEventAt =
      "event_type" in payload && payload.event_type === "presence"
        ? payload.observed_at
        : payload.occurred_at;
    await Promise.all([this.persistInboundOutbox(), this.persistCheckpoint()]);
    void this.drainInboundOutbox();
  }

  private persistInboundOutbox(): Promise<void> {
    this.inboundPersistQueue = this.inboundPersistQueue
      .catch(() => undefined)
      .then(() =>
        saveInboundOutbox(
          this.options.dataDir,
          [...this.inboundOutbox.values()].sort((a, b) =>
            a.queuedAt.localeCompare(b.queuedAt),
          ),
        ),
      );
    return this.inboundPersistQueue;
  }

  private persistCheckpoint(): Promise<void> {
    this.checkpointPersistQueue = this.checkpointPersistQueue
      .catch(() => undefined)
      .then(() =>
        saveRealtimeCheckpoint(this.options.dataDir, this.checkpoint),
      );
    return this.checkpointPersistQueue;
  }

  private drainInboundOutbox(): Promise<void> {
    this.inboundDeliveryQueue = this.inboundDeliveryQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.outboxRetryTimer) {
          clearTimeout(this.outboxRetryTimer);
          this.outboxRetryTimer = undefined;
        }

        // Realtime messages must not wait behind presence/read-receipt noise.
        // Preserve FIFO only inside the same priority class.
        const records = [...this.inboundOutbox.values()].sort((a, b) => {
          const priorityDelta =
            customerCareEventPriority(a.payload as CustomerCareConnectorEvent) -
            customerCareEventPriority(b.payload as CustomerCareConnectorEvent);
          return priorityDelta || a.queuedAt.localeCompare(b.queuedAt);
        });
        let failuresThisPass = 0;

        for (const record of records) {
          // A stale/permanently-invalid event must not block every newer native
          // Zalo message behind it. Old outbox files do not have retry metadata,
          // so missing nextAttemptAt intentionally means "eligible now".
          const retryAt = record.nextAttemptAt
            ? Date.parse(record.nextAttemptAt)
            : Number.NaN;
          if (Number.isFinite(retryAt) && retryAt > Date.now()) continue;

          const payload = record.payload as CustomerCareConnectorEvent;
          console.log("[zalo][trace] webhook.start", {
            eventId: payload.event_id,
            pendingEvents: this.inboundOutbox.size,
            attemptCount: record.attemptCount ?? 0,
          });
          try {
            const context = {
              connectionKey: this.options.connectionKey,
              dataDir: this.options.dataDir,
              webhookURL: this.options.webhookURL,
              webhookSecret: this.options.webhookSecret,
              retryCount: this.options.retryCount,
              retryBaseMs: this.options.retryBaseMs,
            };
            const result =
              "event_type" in payload &&
              payload.event_type === "delivery_status"
                ? await pushDeliveryStatusToCustomerCare(payload, context)
                : "event_type" in payload && payload.event_type === "presence"
                  ? await pushPresenceToCustomerCare(payload, context)
                  : await pushInboundToCustomerCare(payload, context);
            this.inboundOutbox.delete(record.eventId);
            this.rememberProcessedEvent(record.eventId);
            await Promise.all([
              this.persistInboundOutbox(),
              this.persistCheckpoint(),
            ]);
            console.log("[zalo][trace] webhook.ok", {
              eventId: payload.event_id,
              conversationUuid: result.conversation_uuid,
              ...("message_uuid" in result
                ? { messageUuid: result.message_uuid }
                : {}),
              ...("duplicate" in result ? { duplicate: result.duplicate } : {}),
              ...("updated" in result
                ? { updated: result.updated, ignored: result.ignored }
                : {}),
              pendingEvents: this.inboundOutbox.size,
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            const attemptCount = (record.attemptCount ?? 0) + 1;
            const isMessageEvent = !("event_type" in payload);
            const retryDelayMs = isMessageEvent
              ? Math.min(60_000, 2_000 * 2 ** Math.min(attemptCount - 1, 5))
              : Math.min(
                  5 * 60_000,
                  15_000 * 2 ** Math.min(attemptCount - 1, 4),
                );
            const nextAttemptAt = new Date(
              Date.now() + retryDelayMs,
            ).toISOString();

            this.inboundOutbox.set(record.eventId, {
              ...record,
              attemptCount,
              nextAttemptAt,
              lastError: errorMessage,
            });
            await this.persistInboundOutbox();

            this.lastError = `webhook delivery failed: ${errorMessage}`;
            console.error("[zalo][trace] webhook.pending", {
              eventId: payload.event_id,
              pendingEvents: this.inboundOutbox.size,
              attemptCount,
              nextAttemptAt,
              error: errorMessage,
            });

            // Give one newer record a chance. If two records fail in the same
            // pass, assume the gateway/network is broadly unavailable and stop
            // this pass to avoid hammering it. Untouched due records cause an
            // immediate follow-up pass, while failed records keep backoff state.
            failuresThisPass += 1;
            if (failuresThisPass >= 2) break;
          }
        }

        this.scheduleOutboxRetry();
      });
    return this.inboundDeliveryQueue;
  }

  private rememberProcessedEvent(eventId: string): void {
    this.recentInboundEvents.add(eventId);
    const recent = [
      eventId,
      ...this.checkpoint.recentEventIds.filter((value) => value !== eventId),
    ].slice(0, 500);
    this.checkpoint.recentEventIds = recent;
    const keep = new Set(recent);
    for (const value of this.recentInboundEvents) {
      if (!keep.has(value)) this.recentInboundEvents.delete(value);
    }
  }

  private scheduleOutboxRetry(): void {
    if (this.outboxRetryTimer || !this.inboundOutbox.size) return;

    const now = Date.now();
    let earliestEligibleAt = Number.POSITIVE_INFINITY;
    for (const record of this.inboundOutbox.values()) {
      const retryAt = record.nextAttemptAt
        ? Date.parse(record.nextAttemptAt)
        : Number.NaN;
      if (!Number.isFinite(retryAt)) {
        earliestEligibleAt = now;
        break;
      }
      earliestEligibleAt = Math.min(earliestEligibleAt, retryAt);
    }

    const delayMs = Number.isFinite(earliestEligibleAt)
      ? Math.max(250, Math.min(5 * 60_000, earliestEligibleAt - now))
      : 15_000;

    this.outboxRetryTimer = setTimeout(() => {
      this.outboxRetryTimer = undefined;
      void this.drainInboundOutbox();
    }, delayMs);
    this.outboxRetryTimer.unref();
  }

  private trackPresencePeer(userId: string): void {
    const id = userId.trim();
    if (!id || id === this.accountId) return;
    this.presencePeers.add(id);
    if (this.isConnected()) {
      void this.refreshZaloPresence([id]).catch((error) => {
        console.warn(`[zalo] presence refresh failed for ${id}:`, error);
      });
    }
  }

  private startPresencePolling(): void {
    this.stopPresencePolling();
    void this.refreshZaloPresence().catch((error) => {
      console.warn("[zalo] initial presence refresh failed:", error);
    });
    this.presenceTimer = setInterval(() => {
      void this.refreshZaloPresence().catch((error) => {
        console.warn("[zalo] presence refresh failed:", error);
      });
    }, 60_000);
    this.presenceTimer.unref();
  }

  private stopPresencePolling(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = undefined;
  }

  private async markTrackedPresenceUnknown(): Promise<void> {
    if (!this.presencePeers.size) return;
    const observedAt = new Date().toISOString();
    for (const userId of this.presencePeers) {
      const signature = "unknown:";
      if (this.presenceSignatures.get(userId) === signature) continue;
      this.presenceSignatures.set(userId, signature);
      const payload: NormalizedPresenceStatus = {
        event_id: `${this.accountId}:presence:${userId}:unknown:${observedAt}`,
        event_type: "presence",
        provider: "zalo_personal",
        account_id: this.accountId,
        external_thread_id: userId,
        external_user_id: userId,
        state: "unknown",
        observed_at: observedAt,
        source: "native",
      };
      await this.enqueueInbound(payload, `presence:${userId}`, userId);
    }
  }

  private async refreshZaloPresence(explicitIds?: string[]): Promise<void> {
    if (!this.api || !this.isConnected()) return;
    const ids = [
      ...new Set(
        (explicitIds ?? [...this.presencePeers])
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (!ids.length) return;

    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20);
      const response = (await this.api.getUserInfo(batch)) as unknown as Record<
        string,
        unknown
      >;
      const changed =
        response.changed_profiles &&
        typeof response.changed_profiles === "object"
          ? (response.changed_profiles as Record<
              string,
              Record<string, unknown>
            >)
          : {};

      for (const userId of batch) {
        const profile =
          changed[userId] ||
          changed[`${userId}_0`] ||
          Object.values(changed).find(
            (value) => stringValue(value.userId) === userId,
          );
        if (!profile) continue;
        await this.publishZaloPresence(userId, profile);
      }
    }
  }

  private async publishZaloPresence(
    userId: string,
    profile: Record<string, unknown>,
  ): Promise<void> {
    const flags = [profile.isActive, profile.isActivePC, profile.isActiveWeb]
      .map(numberValue)
      .filter((value): value is number => value !== undefined);
    const lastActionRaw = numberValue(profile.lastActionTime);
    if (!flags.length && lastActionRaw == null) return;

    const observedAt = new Date().toISOString();
    const online = flags.some((value) => value === 1);
    const lastActiveAt =
      lastActionRaw && lastActionRaw > 0
        ? providerTimestampToISO(lastActionRaw)
        : online
          ? observedAt
          : undefined;
    const state: NormalizedPresenceStatus["state"] = online
      ? "online"
      : "offline";
    const signature = `${state}:${lastActiveAt || ""}`;
    if (this.presenceSignatures.get(userId) === signature) return;
    this.presenceSignatures.set(userId, signature);

    const payload: NormalizedPresenceStatus = {
      event_id: `${this.accountId}:presence:${userId}:${state}:${lastActiveAt || "unknown"}`,
      event_type: "presence",
      provider: "zalo_personal",
      account_id: this.accountId,
      external_thread_id: userId,
      external_user_id: userId,
      state,
      ...(lastActiveAt ? { last_active_at: lastActiveAt } : {}),
      observed_at: observedAt,
      source: "native",
    };
    console.log("[zalo][trace] presence.detected", {
      eventId: payload.event_id,
      userId,
      state,
      lastActiveAt,
    });
    await this.enqueueInbound(payload, `presence:${userId}`, userId);
  }

  private getCachedUserProfile(
    userId: string,
  ): { displayName: string; avatarUrl: string } | undefined {
    const cached = this.profileCache.get(userId);
    if (!cached || cached.expiresAt <= Date.now()) return undefined;
    return { displayName: cached.displayName, avatarUrl: cached.avatarUrl };
  }

  private async getUserProfileFast(
    userId: string,
    budgetMs = 120,
  ): Promise<{ displayName: string; avatarUrl: string }> {
    const cached = this.getCachedUserProfile(userId);
    if (cached) return cached;

    const lookup = this.getUserProfile(userId);
    const fallback = { displayName: "", avatarUrl: "" };

    // No need to wait when the native event already contains a display name.
    if (budgetMs <= 0) {
      void lookup.catch(() => undefined);
      return fallback;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        lookup,
        new Promise<{ displayName: string; avatarUrl: string }>((resolve) => {
          timer = setTimeout(() => resolve(fallback), budgetMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private getUserProfile(
    userId: string,
  ): Promise<{ displayName: string; avatarUrl: string }> {
    const cached = this.getCachedUserProfile(userId);
    if (cached) return Promise.resolve(cached);

    const fallback = { displayName: "", avatarUrl: "" };
    if (!this.api) return Promise.resolve(fallback);

    const existing = this.profileLookupInFlight.get(userId);
    if (existing) return existing;

    const lookup = (async () => {
      try {
        const response = (await this.api!.getUserInfo(
          userId,
        )) as unknown as Record<string, unknown>;
        const changedProfiles =
          response.changed_profiles &&
          typeof response.changed_profiles === "object"
            ? (response.changed_profiles as Record<
                string,
                Record<string, unknown>
              >)
            : {};
        const profile =
          changedProfiles[userId] ||
          Object.values(changedProfiles)[0] ||
          response;
        const value: CachedProfile = {
          displayName:
            stringValue(profile.displayName) ||
            stringValue(profile.zaloName) ||
            "",
          avatarUrl: stringValue(profile.avatar) || "",
          expiresAt: Date.now() + 30 * 60_000,
        };
        this.profileCache.set(userId, value);
        return { displayName: value.displayName, avatarUrl: value.avatarUrl };
      } catch (error) {
        console.warn(`[zalo] cannot get profile for ${userId}:`, error);
        return fallback;
      }
    })().finally(() => {
      this.profileLookupInFlight.delete(userId);
    });

    this.profileLookupInFlight.set(userId, lookup);
    return lookup;
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

  private scheduleReconnect(delayMs?: number): void {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    let resolvedDelay = delayMs;
    if (resolvedDelay == null) {
      this.reconnectAttempts += 1;
      const base = Math.min(
        60_000,
        1_000 * 2 ** Math.min(this.reconnectAttempts - 1, 6),
      );
      const jitter = Math.floor(base * Math.random() * 0.25);
      resolvedDelay = Math.min(60_000, base + jitter);
    }
    console.log("[zalo][trace] reconnect.scheduled", {
      attempt: this.reconnectAttempts,
      delayMs: resolvedDelay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, resolvedDelay);
    this.reconnectTimer.unref();
  }
}

function customerCareEventPriority(payload: CustomerCareConnectorEvent): number {
  if (!("event_type" in payload)) return 0;
  if (payload.event_type === "delivery_status") return 1;
  if (payload.event_type === "presence") return 2;
  return 1;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function providerTimestampToISO(value: number): string {
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
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

function ensureFileExtension(
  name: string,
  mimeType: string,
): `${string}.${string}` {
  if (/\.[a-z0-9]{1,10}$/i.test(name)) return name as `${string}.${string}`;
  const extension =
    mimeType
      .split("/")[1]
      ?.split(/[;+]/)[0]
      ?.replace(/[^a-z0-9]/gi, "") || "bin";
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
    return JSON.parse(
      JSON.stringify(value, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    ) as unknown;
  } catch {
    return { warning: "profile could not be serialized" };
  }
}
