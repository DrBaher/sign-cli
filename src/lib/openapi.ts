import { SIGN_CLI_VERSION } from "./help-catalog.js";

// Hand-curated route schemas. Kept aligned with src/lib/http-api.ts. When you
// add a new route there, mirror it here too.

type ParamSchema = {
  name: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  description?: string;
  enum?: string[];
};

type RouteSpec = {
  method: "GET" | "POST";
  path: string;
  summary: string;
  body?: ParamSchema[];
  responseExample?: Record<string, unknown>;
};

const ROUTES: RouteSpec[] = [
  {
    method: "GET",
    path: "/v1/health",
    summary: "Liveness + version check.",
    responseExample: { ok: true, result: { ok: true, version: SIGN_CLI_VERSION } },
  },
  {
    method: "POST",
    path: "/v1/signer/list",
    summary: "Pending inbox; supports an optional signer_email filter.",
    body: [{ name: "signer_email", type: "string", description: "Filter to one signer." }],
  },
  {
    method: "POST",
    path: "/v1/signer/fetch-document",
    summary: "Read the unsigned PDF for a request and (optionally) write it to disk.",
    body: [
      { name: "request_id", type: "string", required: true },
      { name: "token", type: "string", required: true },
      { name: "signer_email", type: "string" },
      { name: "out_path", type: "string" },
    ],
  },
  {
    method: "POST",
    path: "/v1/sign",
    summary: "Sign a local-provider request as the holder of the per-signer token.",
    body: [
      { name: "request_id", type: "string", required: true },
      { name: "token", type: "string", required: true },
      { name: "signer_email", type: "string" },
      { name: "signer_name", type: "string" },
      { name: "require_hash", type: "string", description: "Pre-sign safety: expected document SHA-256." },
      { name: "require_title", type: "string", description: "Pre-sign safety: regex the title must match." },
      { name: "require_signer_email", type: "string", description: "Pre-sign safety: expected signer email." },
      { name: "idempotency_key", type: "string", description: "Cache key; same key returns the cached result on retry." },
    ],
  },
  {
    method: "POST",
    path: "/v1/signer/decline",
    summary: "Decline as the token holder; sets request status to declined.",
    body: [
      { name: "request_id", type: "string", required: true },
      { name: "token", type: "string", required: true },
      { name: "signer_email", type: "string" },
      { name: "reason", type: "string" },
    ],
  },
  {
    method: "POST",
    path: "/v1/signer/reissue-token",
    summary: "Mint a new per-signer token; old token is invalidated.",
    body: [
      { name: "request_id", type: "string", required: true },
      { name: "signer_email", type: "string", required: true },
      { name: "token_ttl_minutes", type: "number" },
    ],
  },
  {
    method: "POST",
    path: "/v1/request/show",
    summary: "Enriched snapshot: request, approvals, signedBy[], nextSteps[].",
    body: [{ name: "request_id", type: "string", required: true }],
  },
  {
    method: "POST",
    path: "/v1/request/status",
    summary: "Poll the provider for the latest status.",
    body: [
      { name: "request_id", type: "string", required: true },
      { name: "provider", type: "string", enum: ["dropbox", "docusign", "signwell", "local"] },
    ],
  },
  {
    method: "POST",
    path: "/v1/request/receipt",
    summary: "Produce a signed receipt bundle (audit + signed PDF + manifest.sig + cert).",
    body: [
      { name: "request_id", type: "string", required: true },
      { name: "out_dir", type: "string", required: true },
    ],
  },
  {
    method: "POST",
    path: "/v1/audit/verify",
    summary: "Verify the audit chain's hash linkage for a single request.",
    body: [{ name: "request_id", type: "string", required: true }],
  },
  {
    method: "POST",
    path: "/v1/audit/scan",
    summary: "Verify every request's audit chain in the local DB.",
    body: [
      { name: "provider", type: "string", enum: ["dropbox", "docusign", "signwell", "local"] },
      { name: "status", type: "string" },
      { name: "limit", type: "number" },
    ],
  },
  {
    method: "POST",
    path: "/v1/pdf/detect-signature-field",
    summary: "Detect signature-field placement candidates in a PDF (read-only).",
    body: [
      { name: "pdf_path", type: "string", required: true, description: "Path to the PDF (must pass validateDocumentPath; honors SIGN_ALLOW_ABSOLUTE_DOCS)." },
      { name: "verbose", type: "boolean", description: "Include raw pdfjs text items + page dimensions." },
    ],
  },
  {
    method: "POST",
    path: "/v1/pdf/detect-date-field",
    summary: "Detect date-field placement candidates (with alreadyFilled flag).",
    body: [
      { name: "pdf_path", type: "string", required: true },
      { name: "verbose", type: "boolean" },
    ],
  },
  {
    method: "POST",
    path: "/v1/pdf/stamp-text",
    summary: "Stamp a text string (typically a date) onto a PDF. Mutating.",
    body: [
      { name: "pdf_path", type: "string", required: true },
      { name: "text", type: "string", required: true },
      { name: "out_path", type: "string", required: true },
      { name: "auto_place", type: "string", description: "true|first|last|all|page:N|index:N" },
      { name: "overwrite_filled", type: "boolean", description: "Include already-filled date candidates." },
      { name: "image_page", type: "number" },
      { name: "image_x", type: "number" },
      { name: "image_y", type: "number" },
      { name: "image_width", type: "number" },
      { name: "image_height", type: "number" },
    ],
  },
  {
    method: "POST",
    path: "/v1/preview",
    summary: "Stamp a signature image or rendered name as a draft preview (no PAdES seal). Mutating.",
    body: [
      { name: "pdf_path", type: "string", required: true },
      { name: "out_path", type: "string", required: true },
      { name: "signature_image", type: "string", description: "File path OR data:image/(png|jpeg|svg+xml);base64,... URL." },
      { name: "name_signature", type: "string" },
      { name: "auto_place", type: "string" },
      { name: "preserve_aspect_ratio", type: "boolean" },
      { name: "auto_crop", type: "boolean" },
      { name: "image_page", type: "number" },
      { name: "image_x", type: "number" },
      { name: "image_y", type: "number" },
      { name: "image_width", type: "number" },
      { name: "image_height", type: "number" },
    ],
  },
  {
    method: "POST",
    path: "/v1/document",
    summary: "One-shot DOCX|PDF → sealed PDF. Mutating.",
    body: [
      { name: "input_path", type: "string", required: true },
      { name: "out_path", type: "string", required: true },
      { name: "signer_name", type: "string", required: true },
      { name: "signer_email", type: "string" },
      { name: "title", type: "string" },
      { name: "signature_image", type: "string" },
      { name: "name_signature", type: "string" },
      { name: "auto_place", type: "string", description: "Defaults to 'first'." },
      { name: "preserve_aspect_ratio", type: "boolean" },
      { name: "auto_crop", type: "boolean" },
      { name: "image_page", type: "number" },
      { name: "image_x", type: "number" },
      { name: "image_y", type: "number" },
      { name: "image_width", type: "number" },
      { name: "image_height", type: "number" },
    ],
  },
  {
    method: "POST",
    path: "/v1/profile/list",
    summary: "List configured profiles + active source (read-only).",
  },
  {
    method: "POST",
    path: "/v1/profile/show",
    summary: "Show resolved profile or a specific named profile. Credentials redacted unless show_secrets=true.",
    body: [
      { name: "name", type: "string", description: "Show a specific profile by name; omit for the active resolved view." },
      { name: "show_secrets", type: "boolean" },
    ],
  },
];

function paramsToSchema(params: ParamSchema[] | undefined): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params ?? []) {
    properties[p.name] = {
      type: p.type,
      ...(p.description ? { description: p.description } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

const ERROR_ENVELOPE_SCHEMA = {
  type: "object",
  required: ["ok", "error"],
  properties: {
    ok: { type: "boolean", enum: [false] },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        hint: { type: "string" },
        details: { type: "object", additionalProperties: true },
      },
    },
  },
};

const SUCCESS_ENVELOPE_SCHEMA = {
  type: "object",
  required: ["ok", "result"],
  properties: {
    ok: { type: "boolean", enum: [true] },
    result: {},
  },
};

export function buildOpenApiSpec(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const methods = paths[route.path] ?? {};
    methods[route.method.toLowerCase()] = {
      summary: route.summary,
      ...(route.method === "POST"
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: paramsToSchema(route.body) },
              },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "Success envelope.",
          content: { "application/json": { schema: SUCCESS_ENVELOPE_SCHEMA } },
        },
        "400": {
          description: "Client error envelope (formatCliError shape).",
          content: { "application/json": { schema: ERROR_ENVELOPE_SCHEMA } },
        },
        "401": {
          description: "Bearer auth required.",
          content: { "application/json": { schema: ERROR_ENVELOPE_SCHEMA } },
        },
        "404": {
          description: "Unknown route.",
          content: { "application/json": { schema: ERROR_ENVELOPE_SCHEMA } },
        },
        "500": {
          description: "Internal error envelope.",
          content: { "application/json": { schema: ERROR_ENVELOPE_SCHEMA } },
        },
      },
    };
    paths[route.path] = methods;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "sign-cli HTTP API",
      version: SIGN_CLI_VERSION,
      description:
        "Same agent-as-signer surface as the MCP server, served over plain HTTP. " +
        "All endpoints return either { ok: true, result } on 2xx or the formatCliError envelope on 4xx/5xx.",
    },
    servers: [{ url: "http://127.0.0.1:4000", description: "default sign serve binding" }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", bearerFormat: "opaque token" },
      },
    },
    security: [{ bearer: [] }],
    paths,
  };
}
