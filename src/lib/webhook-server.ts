import http from "node:http";
import {
  handleDocuSignWebhookHttpRequest,
  handleSignWellWebhookHttpRequest,
  handleWebhookHttpRequest,
} from "./webhook-http.js";

export type WebhookProvider = "dropbox" | "signwell" | "docusign";

export type WebhookServerOptions = {
  dbPath: string;
  apiKey: string;       // dropbox API key, signwell webhook secret, or docusign HMAC secret
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
    if (provider === "docusign") {
      await handleDocuSignWebhookHttpRequest(request, response, {
        dbPath: options.dbPath,
        secret: options.apiKey,
        requestId: options.requestId,
      });
      return;
    }
    await handleWebhookHttpRequest(request, response, options);
  });

  server.listen(options.port);
  return server;
}
