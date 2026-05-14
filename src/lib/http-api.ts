import http from "node:http";
import https from "node:https";
import path from "node:path";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { SqliteDb } from "./db.js";
import { formatCliError, SignCliError } from "./sign-error.js";
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
import { renderPrometheusMetrics } from "./prom-metrics.js";
import { TokenBucketLimiter } from "./rate-limit.js";
import { validateDocumentPath, validateOutputPath } from "./validate.js";

function clientKey(req: http.IncomingMessage): string {
  // Trust X-Forwarded-For if present (operators terminating TLS at a load
  // balancer rely on it). Otherwise fall back to the socket peer address.
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0].split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

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
      outDir: validateOutputPath(str(body, "out_dir", true)!),
    }),

  // ─── PDF detection / stamping (mirrors MCP tool surface) ─────────────────
  "POST /v1/pdf/detect-signature-field": async (_db, body) => {
    const { detectSignatureFields } = await import("./signature-field-detection.js");
    const pdfPath = str(body, "pdf_path", true)!;
    validateDocumentPath(pdfPath);
    const verbose = body.verbose === true;
    const detection = await detectSignatureFields(readFileSync(pdfPath), { verbose });
    return {
      pageCount: detection.pageCount,
      acroFormFields: detection.acroFormFields,
      anchorMatches: detection.signatureCandidates.length,
      candidates: detection.signatureCandidates,
      ...(verbose ? { textItemsByPage: detection.textItemsByPage, pageDimensions: detection.pageDimensions } : {}),
    };
  },

  "POST /v1/pdf/detect-date-field": async (_db, body) => {
    const { detectSignatureFields } = await import("./signature-field-detection.js");
    const pdfPath = str(body, "pdf_path", true)!;
    validateDocumentPath(pdfPath);
    const verbose = body.verbose === true;
    const detection = await detectSignatureFields(readFileSync(pdfPath), { verbose });
    return {
      pageCount: detection.pageCount,
      anchorMatches: detection.dateCandidates.length,
      candidates: detection.dateCandidates,
      ...(verbose ? { textItemsByPage: detection.textItemsByPage, pageDimensions: detection.pageDimensions } : {}),
    };
  },

  "POST /v1/pdf/stamp-text": async (_db, body) => {
    const { parseAutoPlaceMode, selectAutoPlaceCandidates, InvalidAutoPlaceValue } =
      await import("./auto-place-selector.js");
    const { detectSignatureFields } = await import("./signature-field-detection.js");
    const { stampPlainTextOnPdf } = await import("./pdf-image-stamp.js");
    const { assessStampQuality } = await import("./stamp-quality.js");

    const pdfPath = str(body, "pdf_path", true)!;
    validateDocumentPath(pdfPath);
    const text = str(body, "text", true)!;
    const outPath = validateOutputPath(str(body, "out_path", true)!);
    const overwriteFilled = body.overwrite_filled === true;

    let pdfBytes: Buffer = readFileSync(pdfPath);
    const explicitComplete = ["image_page", "image_x", "image_y", "image_width", "image_height"]
      .every((k) => typeof body[k] === "number");
    let mode;
    try { mode = parseAutoPlaceMode(str(body, "auto_place")); }
    catch (err) {
      if (err instanceof InvalidAutoPlaceValue) throw new SignCliError({ code: "INVALID_AUTO_PLACE_VALUE", message: err.message, hint: err.hint });
      throw err;
    }
    let primary: { page: number; x: number; y: number; width: number; height: number } | undefined;
    let extras: Array<{ page: number; x: number; y: number; width: number; height: number }> = [];
    if (explicitComplete) {
      primary = {
        page: body.image_page as number, x: body.image_x as number, y: body.image_y as number,
        width: body.image_width as number, height: body.image_height as number,
      };
    } else if (mode.kind !== "none") {
      const detection = await detectSignatureFields(pdfBytes);
      const datePool = overwriteFilled ? detection.dateCandidates : detection.dateCandidates.filter((c) => !c.alreadyFilled);
      const result = selectAutoPlaceCandidates(datePool, mode);
      if (!result.ok) {
        throw new SignCliError({
          code: result.errorCode, message: result.message, hint: result.hint,
          details: { candidates: datePool, allDateCandidates: detection.dateCandidates },
        });
      }
      const [first, ...rest] = result.chosen;
      primary = { page: first.page, x: first.x, y: first.y, width: first.width, height: first.height };
      extras = rest.map((c) => ({ page: c.page, x: c.x, y: c.y, width: c.width, height: c.height }));
    }
    if (!primary) {
      throw new SignCliError({ code: "MISSING_FLAG", message: "pdf/stamp-text requires auto_place or all of image_page/x/y/width/height." });
    }
    const positions = [primary, ...extras];
    for (const pos of positions) pdfBytes = await stampPlainTextOnPdf(pdfBytes, text, pos);
    writeFileSync(outPath, pdfBytes);
    const warnings = [];
    for (const pos of positions) {
      warnings.push(...(await assessStampQuality({ pdfBytes, page: pos.page, x: pos.x, y: pos.y, width: pos.width, height: pos.height })));
    }
    return { ok: true, pdf: pdfPath, out: outPath, text, positions, bytes: pdfBytes.length, warnings };
  },

  "POST /v1/preview": async (_db, body) => {
    const { parseImageInput, stampImageOnPdf, stampTextOnPdf } = await import("./pdf-image-stamp.js");
    const { parseAutoPlaceMode, selectAutoPlaceCandidates, InvalidAutoPlaceValue } =
      await import("./auto-place-selector.js");
    const { detectSignatureFields } = await import("./signature-field-detection.js");
    const { assessStampQuality } = await import("./stamp-quality.js");
    const { verifyPdfStamp } = await import("./pdf-stamp-verify.js");

    const pdfPath = str(body, "pdf_path", true)!;
    validateDocumentPath(pdfPath);
    const outPath = validateOutputPath(str(body, "out_path", true)!);
    const imageFlag = str(body, "signature_image");
    const nameSig = str(body, "name_signature");
    if (!imageFlag && !nameSig) {
      throw new SignCliError({ code: "MISSING_FLAG", message: "preview requires signature_image or name_signature." });
    }
    if (imageFlag && nameSig) {
      throw new SignCliError({ code: "SIGN_VISIBLE_SIG_BOTH", message: "signature_image and name_signature are mutually exclusive." });
    }
    let pdfBytes: Buffer = readFileSync(pdfPath);
    const explicitComplete = ["image_page", "image_x", "image_y", "image_width", "image_height"]
      .every((k) => typeof body[k] === "number");
    let mode;
    try { mode = parseAutoPlaceMode(str(body, "auto_place")); }
    catch (err) {
      if (err instanceof InvalidAutoPlaceValue) throw new SignCliError({ code: "INVALID_AUTO_PLACE_VALUE", message: err.message, hint: err.hint });
      throw err;
    }
    let primary: { page: number; x: number; y: number; width: number; height: number } | undefined;
    let extras: Array<{ page: number; x: number; y: number; width: number; height: number }> = [];
    if (explicitComplete) {
      primary = {
        page: body.image_page as number, x: body.image_x as number, y: body.image_y as number,
        width: body.image_width as number, height: body.image_height as number,
      };
    } else if (mode.kind !== "none") {
      const detection = await detectSignatureFields(pdfBytes);
      const result = selectAutoPlaceCandidates(detection.signatureCandidates, mode);
      if (!result.ok) {
        throw new SignCliError({
          code: result.errorCode, message: result.message, hint: result.hint,
          details: { candidates: result.allCandidates },
        });
      }
      const [first, ...rest] = result.chosen;
      primary = { page: first.page, x: first.x, y: first.y, width: first.width, height: first.height };
      extras = rest.map((c) => ({ page: c.page, x: c.x, y: c.y, width: c.width, height: c.height }));
    }
    if (!primary) {
      throw new SignCliError({ code: "MISSING_FLAG", message: "preview requires auto_place or all of image_page/x/y/width/height." });
    }
    const stampOptions = {
      ...(typeof body.preserve_aspect_ratio === "boolean" ? { preserveAspectRatio: body.preserve_aspect_ratio as boolean } : {}),
      ...(typeof body.auto_crop === "boolean" ? { autoCrop: body.auto_crop as boolean } : {}),
    };
    const positions = [primary, ...extras];
    for (const pos of positions) {
      if (imageFlag) {
        pdfBytes = await stampImageOnPdf(pdfBytes, parseImageInput(imageFlag), pos, stampOptions);
      } else {
        pdfBytes = await stampTextOnPdf(pdfBytes, nameSig!, pos);
      }
    }
    writeFileSync(outPath, pdfBytes);
    const warnings = [];
    const drawnRects: Array<{ page: number; x: number; y: number; width: number; height: number }> = [];
    for (const pos of positions) {
      warnings.push(...(await assessStampQuality({ pdfBytes, page: pos.page, x: pos.x, y: pos.y, width: pos.width, height: pos.height })));
      const probe = await verifyPdfStamp(pdfBytes, pos);
      if (probe.found) {
        drawnRects.push({ page: probe.found.page, x: probe.found.x, y: probe.found.y, width: probe.found.width, height: probe.found.height });
      }
    }
    return { ok: true, pdf: pdfPath, out: outPath, positions, drawnRects, bytes: pdfBytes.length, sealed: false, stampOptions, warnings };
  },

  "POST /v1/document": async (_db, body) => {
    const { parseImageInput } = await import("./pdf-image-stamp.js");
    const { parseAutoPlaceMode, InvalidAutoPlaceValue } = await import("./auto-place-selector.js");
    const { signDocumentOneShot } = await import("./sign-document.js");

    const inputPath = str(body, "input_path", true)!;
    validateDocumentPath(inputPath);
    const outPath = validateOutputPath(str(body, "out_path", true)!);
    const signerName = str(body, "signer_name", true)!;
    const signatureImage = str(body, "signature_image");
    const nameSig = str(body, "name_signature");

    let autoPlaceMode;
    try { autoPlaceMode = parseAutoPlaceMode(str(body, "auto_place")); }
    catch (err) {
      if (err instanceof InvalidAutoPlaceValue) throw new SignCliError({ code: "INVALID_AUTO_PLACE_VALUE", message: err.message, hint: err.hint });
      throw err;
    }
    const explicitComplete = ["image_page", "image_x", "image_y", "image_width", "image_height"]
      .every((k) => typeof body[k] === "number");
    if (autoPlaceMode.kind === "none" && !explicitComplete) autoPlaceMode = { kind: "first" } as const;

    return await signDocumentOneShot({
      inputPath, outPath, signerName,
      ...(str(body, "signer_email") ? { signerEmail: str(body, "signer_email") } : {}),
      ...(str(body, "title") ? { title: str(body, "title") } : {}),
      ...(signatureImage ? { signatureImage: parseImageInput(signatureImage) } : {}),
      ...(nameSig ? { nameSignatureText: nameSig } : {}),
      autoPlaceMode,
      ...(explicitComplete ? { imagePosition: {
        page: body.image_page as number, x: body.image_x as number, y: body.image_y as number,
        width: body.image_width as number, height: body.image_height as number,
      } } : {}),
      ...(signatureImage ? { signatureImageOptions: {
        ...(typeof body.preserve_aspect_ratio === "boolean" ? { preserveAspectRatio: body.preserve_aspect_ratio as boolean } : {}),
        ...(typeof body.auto_crop === "boolean" ? { autoCrop: body.auto_crop as boolean } : {}),
      } } : {}),
    });
  },

  // ─── Profile inspection (read-only) ─────────────────────────────────────
  "POST /v1/profile/list": async () => {
    const { defaultUserFilePath, findProjectFile, readUserFile, loadProfileContext } =
      await import("./profiles.js");
    const userFilePath = defaultUserFilePath();
    const file = readUserFile(userFilePath);
    const projectFile = findProjectFile(process.cwd()) ?? null;
    let active;
    try { active = loadProfileContext({ userFilePath }).activeSource; }
    catch { active = { kind: "none" }; }
    return {
      userFilePath,
      defaultProfile: file?.defaultProfile ?? null,
      profiles: file ? Object.keys(file.profiles).sort() : [],
      projectFile,
      active,
    };
  },

  "POST /v1/profile/show": async (_db, body) => {
    const { defaultUserFilePath, loadProfileContext, readUserFile, redactCredentials, resolveProfileView } =
      await import("./profiles.js");
    const userFilePath = defaultUserFilePath();
    const showSecrets = body.show_secrets === true;
    const name = str(body, "name");
    if (name) {
      const file = readUserFile(userFilePath);
      if (!file || !file.profiles[name]) {
        throw new SignCliError({
          code: "PROFILE_NOT_FOUND",
          message: `No profile named '${name}' in ${userFilePath}.`,
          hint: file ? `Available: ${Object.keys(file.profiles).sort().join(", ")}.` : `No user profile file yet.`,
        });
      }
      const profile = showSecrets ? file.profiles[name] : redactCredentials(file.profiles[name]);
      return { name, userFilePath, profile };
    }
    const ctx = loadProfileContext({ userFilePath });
    return resolveProfileView(ctx, { showSecrets });
  },
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
  // Absolute path to a directory of static files served same-origin under
  // GET /web-demo/* (and GET / redirects to /web-demo/). Lets the bundled
  // dashboard talk to /v1/* without CORS gymnastics.
  webDemoDir?: string;
  // Per-IP token-bucket rate limiter. When set, every /v1/* request consumes
  // one token from the requester's bucket; over-budget requests get a 429
  // with a Retry-After header.
  rateLimit?: { capacity: number; refillPerSec: number };
  // When true, the four request-mutating routes (sign, decline, reissue-token,
  // request/receipt) return 403 with code FORBIDDEN_READ_ONLY. Useful for
  // compliance read-only views or for parking a clone of production behind a
  // dashboard without giving anyone the ability to drive lifecycle.
  readOnly?: boolean;
};

// Routes that mutate request lifecycle state. `readOnly: true` blocks them.
// Audit-event-only side effects (fetch-document, status polling) stay allowed
// because they're read-style use cases — locking those out cripples ops views.
export const READ_ONLY_BLOCKED_ROUTES: ReadonlySet<string> = new Set([
  "POST /v1/sign",
  "POST /v1/signer/decline",
  "POST /v1/signer/reissue-token",
  "POST /v1/request/receipt",
  "POST /v1/pdf/stamp-text",
  "POST /v1/preview",
  "POST /v1/document",
]);

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".ico": "image/x-icon",
};

function tryServeWebDemo(
  webDemoDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  const urlPath = (req.url ?? "/").split("?")[0];
  if (urlPath === "/" || urlPath === "/web-demo" || urlPath === "/web-demo/") {
    res.statusCode = 302;
    res.setHeader("location", "/web-demo/index.html");
    res.end();
    return true;
  }
  if (!urlPath.startsWith("/web-demo/")) return false;
  const rel = urlPath.slice("/web-demo/".length);
  // Block path traversal — resolve and confirm the result is still inside the demo dir.
  const resolved = path.resolve(webDemoDir, rel);
  if (!resolved.startsWith(path.resolve(webDemoDir) + path.sep) && resolved !== path.resolve(webDemoDir)) {
    res.statusCode = 403;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return true;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.statusCode = 200;
  res.setHeader("content-type", STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  if (method === "HEAD") {
    res.end();
  } else {
    res.end(readFileSync(resolved));
  }
  return true;
}

export function listMockHttpRoutes(): string[] {
  return Object.keys(ROUTES);
}

export function startHttpApiServer(opts: HttpServerOptions): http.Server | https.Server {
  const requireAuth = Boolean(opts.authToken);
  const limiter = opts.rateLimit
    ? new TokenBucketLimiter({ capacity: opts.rateLimit.capacity, refillPerSec: opts.rateLimit.refillPerSec })
    : null;
  const handler: http.RequestListener = async (req, res) => {
    const route = `${req.method ?? "GET"} ${(req.url ?? "/").split("?")[0]}`;
    const handler = ROUTES[route];

    // Static demo files are unauthenticated — they're inert HTML/CSS/JS that
    // *call* /v1/* with the user's bearer token. Auth still gates the API.
    if (opts.webDemoDir && tryServeWebDemo(opts.webDemoDir, req, res)) {
      return;
    }

    if (limiter) {
      const decision = limiter.take(clientKey(req));
      res.setHeader("x-ratelimit-limit", String(decision.capacity));
      res.setHeader("x-ratelimit-remaining", String(decision.remaining));
      if (!decision.allowed) {
        res.statusCode = 429;
        res.setHeader("retry-after", String(decision.retryAfterSeconds));
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: { code: "RATE_LIMITED", message: `Too many requests; retry in ${decision.retryAfterSeconds}s.` } }));
        return;
      }
    }

    if (requireAuth) {
      const provided = (req.headers.authorization ?? "").replace(/^Bearer\s+/u, "");
      if (provided !== opts.authToken) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid Bearer token." } }));
        return;
      }
    }

    if (opts.readOnly && READ_ONLY_BLOCKED_ROUTES.has(route)) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        ok: false,
        error: {
          code: "FORBIDDEN_READ_ONLY",
          message: `Server is running with --read-only true; ${route} is disabled.`,
        },
      }));
      return;
    }

    // Prometheus is text/plain; bypass the JSON dispatcher.
    if (route === "GET /v1/metrics") {
      try {
        const body = renderPrometheusMetrics(opts.db);
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
        res.end(body);
      } catch (error) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(`# error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      return;
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
