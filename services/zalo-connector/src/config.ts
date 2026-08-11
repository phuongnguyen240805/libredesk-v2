import path from "node:path";

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const connectorToken = process.env.CONNECTOR_TOKEN?.trim() ?? "";
if (connectorToken.length < 24) {
  throw new Error("CONNECTOR_TOKEN must contain at least 24 characters");
}

const webhookURL = process.env.CUSTOMER_CARE_WEBHOOK_URL?.trim() ?? "";
if (!/^https?:\/\//i.test(webhookURL)) {
  throw new Error("CUSTOMER_CARE_WEBHOOK_URL must be a full http/https URL");
}

const webhookSecret = process.env.CUSTOMER_CARE_WEBHOOK_SECRET?.trim() ?? "";
if (webhookSecret.length < 24) {
  throw new Error("CUSTOMER_CARE_WEBHOOK_SECRET must contain at least 24 characters");
}

export const config = {
  host: process.env.HOST?.trim() || "0.0.0.0",
  port: readPositiveInt("PORT", 3100),
  dataDir: path.resolve(process.env.DATA_DIR?.trim() || "./data"),
  accountId: process.env.ZALO_ACCOUNT_ID?.trim() || "demo-zalo",
  tenantId: readPositiveInt("CUSTOMER_CARE_TENANT_ID", 1),
  connectorToken,
  customerCareWebhookURL: webhookURL,
  customerCareWebhookSecret: webhookSecret,
  inboundRetryCount: readPositiveInt("INBOUND_RETRY_COUNT", 5),
  inboundRetryBaseMs: readPositiveInt("INBOUND_RETRY_BASE_MS", 1000),
};
