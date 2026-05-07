import { readFile } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";

export type DocuSignWebhookSigner = {
  email?: string | null;
  name?: string | null;
  status?: string | null;
  signedDateTime?: string | null;
  routingOrder?: string | number | null;
};

export type DocuSignWebhookPayload = {
  event?: string;
  apiVersion?: string;
  uri?: string;
  retryCount?: number;
  configurationId?: number;
  generatedDateTime?: string;
  data?: {
    envelopeId?: string;
    accountId?: string;
    userId?: string;
    envelopeSummary?: {
      envelopeId?: string;
      status?: string;
      customFields?: Record<string, unknown>;
      envelopeMetadata?: Record<string, string>;
      recipients?: {
        signers?: DocuSignWebhookSigner[];
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export function requireDocuSignWebhookSecret(): string {
  const secret = process.env.DOCUSIGN_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("DOCUSIGN_WEBHOOK_SECRET is not set.");
  }
  return secret;
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function safeEqualBase64(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, "base64");
    const right = Buffer.from(b, "base64");
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

// DocuSign Connect signs the raw request body with HMAC-SHA256 and sends
// the result as a base64 string in `X-DocuSign-Signature-1` (additional
// active keys go to -2, -3, etc.). Pass any of those headers; we accept
// the first that matches.
export function verifyDocuSignCallback(
  secret: string,
  rawBody: string | Buffer,
  signatureHeader: string | string[] | null | undefined,
): boolean {
  const headers = Array.isArray(signatureHeader)
    ? signatureHeader
    : signatureHeader
      ? [signatureHeader]
      : [];
  if (headers.length === 0) return false;
  const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secret).update(bodyBuf).digest();
  const expectedB64 = expected.toString("base64");
  const expectedHex = expected.toString("hex");
  for (const provided of headers) {
    const trimmed = provided.trim();
    if (safeEqualBase64(trimmed, expectedB64)) return true;
    if (safeEqualHex(trimmed.toLowerCase(), expectedHex.toLowerCase())) return true;
  }
  return false;
}

export function parseDocuSignWebhookBody(rawBody: string | Buffer, contentType?: string): DocuSignWebhookPayload {
  const raw = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized && normalized !== "application/json" && normalized !== "text/json") {
    throw new Error(`Unsupported DocuSign callback content-type: ${contentType}`);
  }
  return JSON.parse(raw) as DocuSignWebhookPayload;
}

export async function loadDocuSignWebhookPayloadFile(filePath: string): Promise<DocuSignWebhookPayload> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as DocuSignWebhookPayload;
}

export function extractDocuSignSigners(payload: DocuSignWebhookPayload): DocuSignWebhookSigner[] {
  const signers = payload.data?.envelopeSummary?.recipients?.signers;
  return Array.isArray(signers) ? signers : [];
}

export function getDocuSignEnvelopeSummary(payload: DocuSignWebhookPayload): { envelopeId?: string; status?: string; metadataRequestId?: string | null } {
  const summary = payload.data?.envelopeSummary ?? {};
  return {
    envelopeId: summary.envelopeId ?? payload.data?.envelopeId,
    status: typeof summary.status === "string" ? summary.status : undefined,
    metadataRequestId: typeof summary.envelopeMetadata?.request_id === "string"
      ? summary.envelopeMetadata.request_id
      : null,
  };
}

export function normalizeDocuSignWebhookEventType(event: string | null | undefined): string {
  if (!event) return "unknown";
  return event.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}
