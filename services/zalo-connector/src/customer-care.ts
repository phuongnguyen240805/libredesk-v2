import { createHmac } from "node:crypto";
import { appendDeadLetter } from "./storage.js";

export interface NormalizedZaloInbound {
  event_id: string;
  provider: "zalo_personal";
  account_id: string;
  direction: "incoming" | "outgoing";
  is_self: boolean;
  external_thread_id: string;
  external_message_id: string;
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

export interface CustomerCareInboundResult {
  message_uuid?: string;
  conversation_uuid: string;
  duplicate?: boolean;
}

/**
 * Sends normalized Zalo events to the Nest Customer Care gateway.
 * The connector no longer knows LibreDesk credentials or conversation UUIDs.
 */
export async function pushInboundToCustomerCare(
  payload: NormalizedZaloInbound,
  context: { connectionKey: string; dataDir: string; webhookURL: string; webhookSecret: string; retryCount: number; retryBaseMs: number },
): Promise<CustomerCareInboundResult> {
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

      const webhookBase = context.webhookURL
        .replace(/\/(?:zalo\/)?events\/?$/, "")
        .replace(/\/$/, "");
      const response = await fetch(`${webhookBase}/channels/${context.connectionKey}/events`, {
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
      console.log("[zalo][trace] webhook.response", {
        eventId: payload.event_id,
        direction: payload.direction,
        attempt,
        status: response.status,
        ok: response.ok,
      });

      let decoded: unknown = {};
      if (text) {
        try {
          decoded = JSON.parse(text);
        } catch {
          decoded = { raw: text };
        }
      }

      if (!response.ok) {
        console.error("[zalo][trace] webhook.reject", {
          eventId: payload.event_id,
          direction: payload.direction,
          attempt,
          status: response.status,
          response: text.slice(0, 500),
        });
        throw new Error(`Customer Care gateway returned HTTP ${response.status}: ${text.slice(0, 500)}`);
      }

      const result = unwrapEnvelope(decoded);
      if (!result.conversation_uuid) {
        throw new Error("Customer Care gateway response is missing conversation_uuid");
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < context.retryCount) {
        await sleep(context.retryBaseMs * 2 ** (attempt - 1));
      }
    }
  }

  await appendDeadLetter(context.dataDir, payload, lastError);
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function unwrapEnvelope(value: unknown): CustomerCareInboundResult {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Customer Care gateway response");
  }
  const record = value as Record<string, unknown>;
  let candidate = record;
  // Nest TransformInterceptor envelope: { code, data, message }
  if (record.data && typeof record.data === "object") {
    candidate = record.data as Record<string, unknown>;
    // Some deployments wrap the controller result one more time.
    if (candidate.data && typeof candidate.data === "object") {
      candidate = candidate.data as Record<string, unknown>;
    }
  }

  return {
    message_uuid: candidate.message_uuid ? String(candidate.message_uuid) : undefined,
    conversation_uuid: String(candidate.conversation_uuid ?? ""),
    duplicate: Boolean(candidate.duplicate ?? false),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
