import { createHmac } from "node:crypto";

export interface NormalizedZaloInbound {
  event_id: string;
  provider: "zalo_personal";
  account_id: string;
  direction: "incoming" | "outgoing";
  is_self: boolean;
  external_thread_id: string;
  external_message_id: string;
  client_message_id?: string;
  thread_type: "user" | "group";
  occurred_at: string;
  sender: {
    external_id: string;
    display_name: string;
    avatar_url?: string;
  };
  message: {
    type: "text";
    text: string;
  };
}

export type CustomerCareDeliveryStatus = "delivered" | "read";

export interface NormalizedDeliveryStatus {
  event_id: string;
  event_type: "delivery_status";
  provider: "zalo_personal" | "facebook_personal";
  account_id: string;
  external_thread_id: string;
  external_message_id?: string;
  external_message_ids?: string[];
  client_message_id?: string;
  status: CustomerCareDeliveryStatus;
  occurred_at: string;
  /** For Facebook Lightspeed readReceipt: all outgoing messages <= watermark are read. */
  watermark_at?: string;
}


export interface NormalizedPresenceStatus {
  event_id: string;
  event_type: "presence";
  provider: "zalo_personal" | "facebook_personal";
  account_id: string;
  external_thread_id: string;
  external_user_id: string;
  state: "online" | "offline" | "unknown";
  last_active_at?: string;
  observed_at: string;
  source: "native" | "native_activity";
}

export type CustomerCareConnectorEvent = NormalizedZaloInbound | NormalizedDeliveryStatus | NormalizedPresenceStatus;

export interface CustomerCareInboundResult {
  message_uuid?: string;
  conversation_uuid: string;
  duplicate?: boolean;
}

export interface CustomerCareDeliveryResult {
  conversation_uuid?: string;
  updated: number;
  ignored: number;
}

export interface CustomerCarePresenceResult {
  conversation_uuid?: string;
  updated: number;
  ignored: number;
}

export interface CustomerCareWebhookContext {
  connectionKey: string;
  dataDir: string;
  webhookURL: string;
  webhookSecret: string;
  retryCount: number;
  retryBaseMs: number;
}

/** Send a normalized message event to Nest Customer Care. */
export async function pushInboundToCustomerCare(
  payload: NormalizedZaloInbound,
  context: CustomerCareWebhookContext,
): Promise<CustomerCareInboundResult> {
  const decoded = await postSigned(payload, context, "events", "zalo");
  const result = unwrapInboundEnvelope(decoded);
  if (!result.conversation_uuid) {
    throw new Error("Customer Care gateway response is missing conversation_uuid");
  }
  return result;
}

/** Send delivered/read receipts without mixing them into the message DTO. */
export async function pushDeliveryStatusToCustomerCare(
  payload: NormalizedDeliveryStatus,
  context: CustomerCareWebhookContext,
): Promise<CustomerCareDeliveryResult> {
  // event_type is connector-internal routing metadata. The Nest /delivery DTO
  // intentionally does not expose this field and ValidationPipe rejects unknown
  // properties with HTTP 422. Clone instead of mutating the durable outbox payload,
  // then sign/send exactly the sanitized raw body.
  const { event_type: _eventType, ...webhookPayload } = payload;
  const decoded = await postSigned(webhookPayload, context, "delivery", "zalo");
  return unwrapDeliveryEnvelope(decoded);
}

/** Send normalized customer presence without mixing it into message events. */
export async function pushPresenceToCustomerCare(
  payload: NormalizedPresenceStatus,
  context: CustomerCareWebhookContext,
): Promise<CustomerCarePresenceResult> {
  const decoded = await postSigned(payload, context, "presence", "zalo");
  return unwrapPresenceEnvelope(decoded);
}

async function postSigned(
  payload: { event_id: string },
  context: CustomerCareWebhookContext,
  endpoint: "events" | "delivery" | "presence",
  logPrefix: string,
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= context.retryCount; attempt += 1) {
    try {
      const body = JSON.stringify(payload);
      const timestamp = String(Date.now());
      const channelSecret = createHmac("sha256", context.webhookSecret)
        .update(`customer-care-channel:${context.connectionKey}`)
        .digest("hex");
      const signature = createHmac("sha256", channelSecret)
        .update(`${timestamp}.${body}`)
        .digest("hex");
      const url = connectorEndpoint(context.webhookURL, context.connectionKey, endpoint);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-customer-care-timestamp": timestamp,
          "x-customer-care-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });

      const text = await response.text();
      console.log(`[${logPrefix}][trace] webhook.response`, {
        eventId: payload.event_id, endpoint, attempt, status: response.status, ok: response.ok,
      });

      let decoded: unknown = {};
      if (text) {
        try { decoded = JSON.parse(text); } catch { decoded = { raw: text }; }
      }
      if (!response.ok) {
        throw new Error(`Customer Care gateway returned HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      return decoded;
    } catch (error) {
      lastError = error;
      if (attempt < context.retryCount) {
        await sleep(context.retryBaseMs * 2 ** (attempt - 1));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function connectorEndpoint(rawURL: string, connectionKey: string, endpoint: "events" | "delivery" | "presence"): string {
  const base = rawURL
    .replace(/\/channels\/[^/]+\/(?:events|delivery|presence)\/?$/, "")
    .replace(/\/(?:zalo\/)?events\/?$/, "")
    .replace(/\/$/, "");
  return `${base}/channels/${connectionKey}/${endpoint}`;
}

function envelope(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  let candidate = value as Record<string, unknown>;
  if (candidate.data && typeof candidate.data === "object") {
    candidate = candidate.data as Record<string, unknown>;
    if (candidate.data && typeof candidate.data === "object") {
      candidate = candidate.data as Record<string, unknown>;
    }
  }
  return candidate;
}

function unwrapInboundEnvelope(value: unknown): CustomerCareInboundResult {
  const candidate = envelope(value);
  return {
    message_uuid: candidate.message_uuid ? String(candidate.message_uuid) : undefined,
    conversation_uuid: String(candidate.conversation_uuid ?? ""),
    duplicate: Boolean(candidate.duplicate ?? false),
  };
}

function unwrapDeliveryEnvelope(value: unknown): CustomerCareDeliveryResult {
  const candidate = envelope(value);
  return {
    conversation_uuid: candidate.conversation_uuid ? String(candidate.conversation_uuid) : undefined,
    updated: Number(candidate.updated ?? 0),
    ignored: Number(candidate.ignored ?? 0),
  };
}

function unwrapPresenceEnvelope(value: unknown): CustomerCarePresenceResult {
  const candidate = envelope(value);
  return {
    conversation_uuid: candidate.conversation_uuid ? String(candidate.conversation_uuid) : undefined,
    updated: Number(candidate.updated ?? 0),
    ignored: Number(candidate.ignored ?? 0),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
