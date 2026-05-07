import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import type { SqliteDb } from "./db.js";
import { formatCliError } from "./sign-error.js";
import {
  declineSigningRequestAsSigner,
  exportRequestReceipt,
  fetchUnsignedDocumentForSigner,
  getRequestSnapshot,
  getSigningRequestStatus,
  listSignerInbox,
  reissueSignerToken,
  scanAllAuditChains,
  signSigningRequest,
  verifyRequestAuditChain,
} from "./signing-service.js";

import { SIGN_CLI_VERSION } from "./help-catalog.js";
import { buildOpenApiSpec } from "./openapi.js";

type RouteHandler = (db: SqliteDb, body: Record<string, unknown>) => Promise<unknown> | unknown;

function str(body: Record<string, unknown>, key: string, required: boolean = false): string | undefined {
  const value = body[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`Missing required field: ${key}`);
  return undefined;
}

const ROUTES: Record<string, RouteHandler> = {
  "GET /v1/health": (_db) => ({ ok: true, version: SIGN_CLI_VERSION }),

  "GET /v1/openapi.json": (_db) => buildOpenApiSpec(),

  "POST /v1/signer/list": (db, body) =>
    listSignerInbox(db, { signerEmail: str(body, "signer_email") }),

  "POST /v1/signer/fetch-document": (db, body) =>
    fetchUnsignedDocumentForSigner(db, {
      requestId: str(body, "request_id", true)!,
      token: str(body, "token", true)!,
      signerEmail: str(body, "signer_email"),
      outPath: str(body, "out_path"),
    }),

  "POST /v1/sign": (db, body) =>
    signSigningRequest(db, {
      requestId: str(body, "request_id", true)!,
      token: str(body, "token", true)!,
      signerEmail: str(body, "signer_email"),
      signerName: str(body, "signer_name"),
      requireHash: str(body, "require_hash"),
      requireTitle: str(body, "require_title"),
      requireSignerEmail: str(body, "require_signer_email"),
      idempotencyKey: str(body, "idempotency_key"),
    }),

  "POST /v1/signer/decline": (db, body) =>
    declineSigningRequestAsSigner(db, {
      requestId: str(body, "request_id", true)!,
      token: str(body, "token", true)!,
      signerEmail: str(body, "signer_email"),
      reason: str(body, "reason"),
    }),

  "POST /v1/signer/reissue-token": (db, body) =>
    reissueSignerToken(db, {
      requestId: str(body, "request_id", true)!,
      signerEmail: str(body, "signer_email", true)!,
      tokenTtlMinutes: typeof body.token_ttl_minutes === "number" ? body.token_ttl_minutes as number : undefined,
    }),

  "POST /v1/request/show": (db, body) =>
    getRequestSnapshot(db, str(body, "request_id", true)!),

  "POST /v1/request/status": async (db, body) => {
    const provider = str(body, "provider");
    return await getSigningRequestStatus(db, {
      requestId: str(body, "request_id", true)!,
      provider: provider as "dropbox" | "docusign" | "signwell" | "local" | undefined,
      apiKey: provider === "dropbox"
        ? process.env.DROPBOX_SIGN_API_KEY
        : provider === "signwell"
          ? process.env.SIGNWELL_API_KEY
          : undefined,
    });
  },

  "POST /v1/audit/verify": (db, body) =>
    verifyRequestAuditChain(db, str(body, "request_id", true)!),

  "POST /v1/audit/scan": (db, body) =>
    scanAllAuditChains(db, {
      provider: str(body, "provider") as "dropbox" | "docusign" | "signwell" | "local" | undefined,
      status: str(body, "status"),
      limit: typeof body.limit === "number" ? body.limit as number : undefined,
    }),

  "POST /v1/request/receipt": (db, body) =>
    exportRequestReceipt(db, {
      requestId: str(body, "request_id", true)!,
      outDir: str(body, "out_dir", true)!,
    }),
};

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return {};
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export type HttpServerOptions = {
  db: SqliteDb;
  port: number;
  bind?: string;
  authToken?: string;
  tls?: { certPath: string; keyPath: string; caPath?: string };
};

export function listMockHttpRoutes(): string[] {
  return Object.keys(ROUTES);
}

export function startHttpApiServer(opts: HttpServerOptions): http.Server | https.Server {
  const requireAuth = Boolean(opts.authToken);
  const handler: http.RequestListener = async (req, res) => {
    const route = `${req.method ?? "GET"} ${(req.url ?? "/").split("?")[0]}`;
    const handler = ROUTES[route];

    if (requireAuth) {
      const provided = (req.headers.authorization ?? "").replace(/^Bearer\s+/u, "");
      if (provided !== opts.authToken) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid Bearer token." } }));
        return;
      }
    }

    if (!handler) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: { code: "UNKNOWN_ROUTE", message: `No handler for ${route}` } }));
      return;
    }

    try {
      const body = req.method === "POST" || req.method === "PUT" ? await readJsonBody(req) : {};
      const result = await handler(opts.db, body);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      // OpenAPI consumers expect the raw spec, not the wrapped envelope.
      if (route === "GET /v1/openapi.json") {
        res.end(JSON.stringify(result));
      } else {
        res.end(JSON.stringify({ ok: true, result }));
      }
    } catch (error) {
      const envelope = formatCliError(error);
      res.statusCode = envelope.error.code === "INTERNAL" ? 500 : 400;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(envelope));
    }
  };

  let server: http.Server | https.Server;
  if (opts.tls) {
    server = https.createServer(
      {
        cert: readFileSync(opts.tls.certPath),
        key: readFileSync(opts.tls.keyPath),
        ...(opts.tls.caPath ? { ca: readFileSync(opts.tls.caPath) } : {}),
      },
      handler,
    );
  } else {
    server = http.createServer(handler);
  }
  server.listen(opts.port, opts.bind ?? "127.0.0.1");
  return server;
}
