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

export function parseWebhookPayload(raw: string): DropboxCallbackPayload {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.json === "string") {
    return JSON.parse(parsed.json) as DropboxCallbackPayload;
  }
  return parsed as DropboxCallbackPayload;
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
