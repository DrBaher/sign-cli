import { openDatabase } from "./db.js";
import { formatCliError } from "./sign-error.js";
import {
  ingestDocuSignWebhookPayload,
  ingestSignWellWebhookPayload,
  ingestWebhookPayload,
} from "./signing-service.js";
import { parseWebhookRequestBody, verifyDropboxCallback } from "./webhook.js";
import { parseSignWellWebhookBody, verifySignWellCallback } from "./signwell-webhook.js";
import {
  parseDocuSignWebhookBody,
  verifyDocuSignCallback,
} from "./docusign-webhook.js";

type WebhookLikeRequest = {
  headers: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
};

type WebhookLikeResponse = {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
};

async function readRequestBody(request: WebhookLikeRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/** Structured webhook error envelope. Routes the error through formatCliError
 *  so (a) known secrets are redacted from the message and (b) the shape is
 *  consistent across the three provider handlers. */
function writeWebhookError(response: WebhookLikeResponse, error: unknown): void {
  response.statusCode = 400;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(formatCliError(error)));
}

export async function handleWebhookHttpRequest(
  request: WebhookLikeRequest,
  response: WebhookLikeResponse,
  options: { dbPath: string; apiKey: string; requestId?: string },
): Promise<void> {
  try {
    const rawBody = await readRequestBody(request);
    const payload = parseWebhookRequestBody(rawBody, headerString(request.headers["content-type"]));
    const verified = verifyDropboxCallback(options.apiKey, payload);
    const db = openDatabase(options.dbPath);
    try {
      const result = ingestWebhookPayload(db, {
        payload,
        apiKey: options.apiKey,
        requestId: options.requestId,
      });

      response.statusCode = verified ? 200 : 401;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: verified,
        message: verified ? "Hello API Event Received" : "Invalid Dropbox callback signature.",
        ...result,
      }));
    } finally {
      db.close();
    }
  } catch (error) {
    writeWebhookError(response, error);
  }
}

export async function handleDocuSignWebhookHttpRequest(
  request: WebhookLikeRequest,
  response: WebhookLikeResponse,
  options: { dbPath: string; secret: string; requestId?: string },
): Promise<void> {
  try {
    const rawBody = await readRequestBody(request);
    const payload = parseDocuSignWebhookBody(rawBody, headerString(request.headers["content-type"]));
    // DocuSign Connect supports up to three active HMAC keys; headers are X-DocuSign-Signature-1/-2/-3.
    const signatureHeaders: string[] = [];
    for (const slot of ["x-docusign-signature-1", "x-docusign-signature-2", "x-docusign-signature-3"]) {
      const value = request.headers[slot];
      if (typeof value === "string") signatureHeaders.push(value);
      else if (Array.isArray(value)) signatureHeaders.push(...value);
    }
    const verified = verifyDocuSignCallback(options.secret, rawBody, signatureHeaders);
    const db = openDatabase(options.dbPath);
    try {
      const result = ingestDocuSignWebhookPayload(db, {
        payload,
        secret: options.secret,
        rawBody,
        signatureHeader: signatureHeaders,
        requestId: options.requestId,
      });
      response.statusCode = verified ? 200 : 401;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: verified,
        message: verified ? "DocuSign event received" : "Invalid DocuSign callback signature.",
        ...result,
      }));
    } finally {
      db.close();
    }
  } catch (error) {
    writeWebhookError(response, error);
  }
}

export async function handleSignWellWebhookHttpRequest(
  request: WebhookLikeRequest,
  response: WebhookLikeResponse,
  options: { dbPath: string; apiKey: string; requestId?: string },
): Promise<void> {
  try {
    const rawBody = await readRequestBody(request);
    const payload = parseSignWellWebhookBody(rawBody, headerString(request.headers["content-type"]));
    const signatureHeader = headerString(request.headers["x-signwell-webhook-signature"])
      ?? headerString(request.headers["x-signwell-signature"])
      ?? null;
    const verified = verifySignWellCallback(options.apiKey, payload, signatureHeader);
    const db = openDatabase(options.dbPath);
    try {
      const result = ingestSignWellWebhookPayload(db, {
        payload,
        secret: options.apiKey,
        signatureHeader,
        requestId: options.requestId,
      });
      response.statusCode = verified ? 200 : 401;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        ok: verified,
        message: verified ? "SignWell event received" : "Invalid SignWell callback signature.",
        ...result,
      }));
    } finally {
      db.close();
    }
  } catch (error) {
    writeWebhookError(response, error);
  }
}
