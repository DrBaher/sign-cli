import { openDatabase } from "./db.js";
import { ingestWebhookPayload } from "./signing-service.js";
import { parseWebhookRequestBody, verifyDropboxCallback } from "./webhook.js";

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

export async function handleWebhookHttpRequest(
  request: WebhookLikeRequest,
  response: WebhookLikeResponse,
  options: { dbPath: string; apiKey: string; requestId?: string },
): Promise<void> {
  try {
    const rawBody = await readRequestBody(request);
    const payload = parseWebhookRequestBody(rawBody, request.headers["content-type"]);
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
    response.statusCode = 400;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
