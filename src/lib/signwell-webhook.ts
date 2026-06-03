import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { hmacSha256 } from "./util.js";

/** Constant-time hex/string comparison after a length check. Avoids leaking
 *  the expected HMAC via early-exit timing on `===`. */
function timingSafeStringEq(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export type SignWellWebhookPayload = {
  event?: {
    type?: string;
    time?: number | string;
    hash?: string;
    related_signer_id?: string | null;
  };
  data?: {
    object?: SignWellWebhookDocument;
  };
  document?: SignWellWebhookDocument;
  [key: string]: unknown;
};

export type SignWellWebhookDocument = {
  id?: string;
  status?: string;
  recipients?: Array<{
    id?: string;
    status?: string;
    signed_at?: string | null;
  }>;
  metadata?: Record<string, string>;
  [key: string]: unknown;
};

export function requireSignWellWebhookSecret(): string {
  const secret = process.env.SIGNWELL_WEBHOOK_SECRET?.trim()
    || process.env.SIGNWELL_API_KEY?.trim();
  if (!secret) {
    throw new Error("SIGNWELL_WEBHOOK_SECRET (or SIGNWELL_API_KEY fallback) is not set.");
  }
  return secret;
}

function parseJsonPayload(raw: string): SignWellWebhookPayload {
  return JSON.parse(raw) as SignWellWebhookPayload;
}

export function parseSignWellWebhookBody(rawBody: string | Buffer, contentType?: string): SignWellWebhookPayload {
  const raw = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (!normalized || normalized === "application/json" || normalized === "text/json") {
    return parseJsonPayload(raw);
  }
  throw new Error(`Unsupported SignWell callback content-type: ${contentType}`);
}

export async function loadSignWellWebhookPayloadFile(filePath: string): Promise<SignWellWebhookPayload> {
  const raw = await readFile(filePath, "utf8");
  return parseJsonPayload(raw);
}

export function getSignWellWebhookDocument(payload: SignWellWebhookPayload): SignWellWebhookDocument | null {
  return payload?.data?.object ?? payload?.document ?? null;
}

export function verifySignWellCallback(
  secret: string,
  payload: SignWellWebhookPayload,
  signatureHeader?: string | null,
): boolean {
  const eventType = payload?.event?.type;
  const eventTime = payload?.event?.time;
  const eventHash = payload?.event?.hash ?? signatureHeader ?? null;
  if (!eventType || eventTime === undefined || eventTime === null || !eventHash) {
    return false;
  }
  const computed = hmacSha256(secret, `${eventTime}${eventType}`);
  return timingSafeStringEq(computed, String(eventHash));
}

export function normalizeSignWellEventType(eventType: string | undefined | null): string {
  if (!eventType) {
    return "unknown";
  }
  const normalized = String(eventType).trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (normalized.endsWith("completed") || normalized === "document_completed" || normalized === "document_signed_all") {
    return "completed";
  }
  if (normalized.endsWith("signed") || normalized === "recipient_signed") {
    return "signed";
  }
  if (normalized.endsWith("declined") || normalized === "document_declined") {
    return "declined";
  }
  if (normalized.endsWith("expired") || normalized.endsWith("canceled") || normalized.endsWith("cancelled") || normalized.endsWith("voided")) {
    return "declined";
  }
  if (normalized.includes("bounced") || normalized.endsWith("error") || normalized.endsWith("failed")) {
    return "error";
  }
  if (normalized.endsWith("sent") || normalized.endsWith("created") || normalized === "document_sent") {
    return "sent";
  }
  return normalized;
}

export function extractSignWellRecipientIds(document: SignWellWebhookDocument | null): string[] {
  if (!document?.recipients) {
    return [];
  }
  return document.recipients
    .map((recipient) => recipient?.id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}
