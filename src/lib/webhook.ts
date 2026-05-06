import { readFile } from "node:fs/promises";
import { hmacSha256 } from "./util.js";

export type DropboxCallbackPayload = {
  event?: {
    event_time?: string;
    event_type?: string;
    event_hash?: string;
    event_metadata?: Record<string, unknown>;
  };
  signature_request?: {
    signature_request_id?: string;
    metadata?: Record<string, string>;
  };
  [key: string]: unknown;
};

function parseJsonPayload(raw: string): DropboxCallbackPayload {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.json === "string") {
    return JSON.parse(parsed.json) as DropboxCallbackPayload;
  }
  return parsed as DropboxCallbackPayload;
}

export function parseWebhookPayload(raw: string): DropboxCallbackPayload {
  return parseJsonPayload(raw);
}

function extractMultipartPart(raw: string, boundary: string, fieldName: string): string | null {
  const marker = `--${boundary}`;
  const parts = raw.split(marker);

  for (const part of parts) {
    if (!part.includes(`name="${fieldName}"`)) {
      continue;
    }

    const bodyIndex = part.indexOf("\r\n\r\n");
    if (bodyIndex === -1) {
      continue;
    }

    const body = part.slice(bodyIndex + 4).replace(/\r\n--$/u, "").trim();
    if (body) {
      return body;
    }
  }

  return null;
}

export function parseWebhookRequestBody(rawBody: string | Buffer, contentType?: string): DropboxCallbackPayload {
  const raw = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();

  if (!normalized || normalized === "application/json" || normalized === "text/json") {
    return parseJsonPayload(raw);
  }

  if (normalized === "application/x-www-form-urlencoded") {
    const parsed = new URLSearchParams(raw);
    const json = parsed.get("json");
    if (!json) {
      throw new Error("Dropbox callback form body is missing the json field.");
    }
    return JSON.parse(json) as DropboxCallbackPayload;
  }

  if (normalized === "multipart/form-data") {
    const boundaryMatch = contentType?.match(/boundary=(?:"?)([^";]+)(?:"?)/iu);
    const boundary = boundaryMatch?.[1];
    if (!boundary) {
      throw new Error("Multipart Dropbox callback is missing a boundary.");
    }
    const json = extractMultipartPart(raw, boundary, "json");
    if (!json) {
      throw new Error("Multipart Dropbox callback is missing the json field.");
    }
    return JSON.parse(json) as DropboxCallbackPayload;
  }

  throw new Error(`Unsupported Dropbox callback content-type: ${contentType}`);
}

export function verifyDropboxCallback(apiKey: string, payload: DropboxCallbackPayload): boolean {
  const eventType = payload.event?.event_type;
  const eventTime = payload.event?.event_time;
  const eventHash = payload.event?.event_hash;

  if (!eventType || !eventTime || !eventHash) {
    return false;
  }

  const expected = hmacSha256(apiKey, `${eventTime}${eventType}`);
  return expected === eventHash;
}

export async function loadWebhookPayloadFile(filePath: string): Promise<DropboxCallbackPayload> {
  const raw = await readFile(filePath, "utf8");
  return parseWebhookPayload(raw);
}
