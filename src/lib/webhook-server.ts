import http from "node:http";
import { handleSignWellWebhookHttpRequest, handleWebhookHttpRequest } from "./webhook-http.js";

export type WebhookProvider = "dropbox" | "signwell";

export type WebhookServerOptions = {
  dbPath: string;
  apiKey: string;
  port: number;
  path: string;
  requestId?: string;
  provider?: WebhookProvider;
};

export function startWebhookServer(options: WebhookServerOptions): http.Server {
  const provider = options.provider ?? "dropbox";
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method !== "POST" || requestUrl.pathname !== options.path) {
      response.statusCode = request.method === "POST" ? 404 : 405;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end("Not Found");
      return;
    }

    if (provider === "signwell") {
      await handleSignWellWebhookHttpRequest(request, response, options);
      return;
    }
    await handleWebhookHttpRequest(request, response, options);
  });

  server.listen(options.port);
  return server;
}
