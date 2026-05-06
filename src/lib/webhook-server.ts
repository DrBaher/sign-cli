import http from "node:http";
import { openDatabase } from "./db.js";
import { ingestWebhookPayload } from "./signing-service.js";
import { parseWebhookRequestBody, verifyDropboxCallback } from "./webhook.js";

export type WebhookServerOptions = {
  dbPath: string;
  apiKey: string;
  port: number;
  path: string;
  requestId?: string;
};

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function handleWebhookHttpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: { dbPath: string; apiKey: string; requestId?: string },
): Promise<void> {
  try {
    const rawBody = await readRequestBody(request);
    const payload = parseWebhookRequestBody(rawBody, request.headers["content-type"]);
    const verified = verifyDropboxCallback(options.apiKey, payload);
    const db = openDatabase(options.dbPath);
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
  } catch (error) {
    response.statusCode = 400;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function startWebhookServer(options: WebhookServerOptions): http.Server {
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method !== "POST" || requestUrl.pathname !== options.path) {
      response.statusCode = request.method === "POST" ? 404 : 405;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Not Found");
      return;
    }

    await handleWebhookHttpRequest(request, response, options);
  });

  server.listen(options.port);
  return server;
}
