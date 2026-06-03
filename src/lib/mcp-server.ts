import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { timingSafeEqual } from "node:crypto";
import type { SqliteDb } from "./db.js";
import { resolveSignProvider, type SignProvider } from "./providers.js";
import { getMcpPrompt, listMcpPrompts } from "./mcp-prompts.js";
import { subscribeResource } from "./resource-watch.js";
import { formatCliError, SignCliError } from "./sign-error.js";
import {
  declineSigningRequestAsSigner,
  exportRequestReceipt,
  fetchUnsignedDocumentForSigner,
  getRequestSnapshot,
  getSigningRequestStatus,
  listAuditEvents,
  listSignerInbox,
  listSigningRequests,
  readLocalDocumentForResource,
  reissueSignerToken,
  scanAllAuditChains,
  signSigningRequest,
  verifyRequestAuditChain,
  watchSigningRequestStatus,
} from "./signing-service.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "sign-cli-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

export type McpEmitProgress = (progress: { progress: number; total?: number; message?: string }) => void;

export type ToolContext = {
  emitProgress?: McpEmitProgress;
  // When false, tools must refuse to return plaintext secrets (e.g.
  // profile_show show_secrets=true). Set true on the trusted stdio transport
  // and on the HTTP transport ONLY when a bearer auth token is configured —
  // so an unauthenticated network client can never exfiltrate provider keys.
  secretsAllowed?: boolean;
};

type ToolHandler = (
  db: SqliteDb,
  args: Record<string, unknown>,
  ctx: ToolContext,
) => unknown | Promise<unknown>;

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // Optional output schema — JSON Schema for the success-case result. Lets
  // generic agent loops validate responses without per-tool special-casing.
  outputSchema?: Record<string, unknown>;
  // Optional schema for progress notifications when the tool calls
  // emitProgress. Documents the shape of `notifications/progress` payload —
  // useful for clients that want to type-check streamed updates.
  progressSchema?: Record<string, unknown>;
  handler: ToolHandler;
};

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredStr(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required argument: ${key}`);
  }
  return value;
}

function resolveProviderArg(args: Record<string, unknown>): SignProvider | undefined {
  const raw = str(args, "provider");
  return raw ? resolveSignProvider(raw) : undefined;
}

function providerApiKey(provider?: SignProvider): string | undefined {
  if (provider === "dropbox") return process.env.DROPBOX_SIGN_API_KEY;
  if (provider === "signwell") return process.env.SIGNWELL_API_KEY;
  return undefined;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "signer_list",
    description:
      "List pending local-provider requests where the given signer is a recipient. " +
      "Pass signer_email to scope; omit to list every pending local request the inbox can see.",
    inputSchema: {
      type: "object",
      properties: { signer_email: { type: "string", description: "Signer email to filter by." } },
    },
    // outputSchema omitted: this tool returns a JSON array, but the MCP spec
    // and Smithery require outputSchema.type to be "object". Rather than break
    // the wire shape that existing clients (Claude Code, Cursor, etc.) consume,
    // we expose no outputSchema and let clients introspect the array directly.
    handler: (db, args) => listSignerInbox(db, { signerEmail: str(args, "signer_email") }),
  },
  {
    name: "signer_fetch_document",
    description:
      "Read the unsigned PDF for a local signing request. Requires the per-signer token. " +
      "If out_path is provided, also writes the file to disk. Records request.signer_fetched_document.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        token: { type: "string", description: "Per-signer token from request create's tokens[]." },
        signer_email: { type: "string", description: "Optional cross-check against the token's signer." },
        out_path: { type: "string", description: "Optional path to write the unsigned PDF." },
      },
      required: ["request_id", "token"],
    },
    outputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        providerRequestId: { type: "string" },
        signerEmail: { type: "string" },
        title: { type: "string" },
        bytes: { type: "number" },
        sha256: { type: "string" },
        outPath: { type: ["string", "null"] },
        existingSignatures: {
          type: "object",
          description: "Pre-sign view of any existing PADES signatures on the PDF. Always present even when the PDF has no signatures (count=0).",
          properties: {
            count: { type: "number" },
            hasSignature: { type: "boolean" },
            allDigestsOk: { type: "boolean" },
            signers: { type: "array" },
            warnings: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    handler: (db, args) =>
      fetchUnsignedDocumentForSigner(db, {
        requestId: requiredStr(args, "request_id"),
        token: requiredStr(args, "token"),
        signerEmail: str(args, "signer_email"),
        outPath: str(args, "out_path"),
      }),
  },
  {
    name: "sign",
    description:
      "Sign a local signing request as the holder of the given token. Requires --provider local. " +
      "The token resolves the signer; pre-sign safety checks (require_hash, require_title, require_signer_email) " +
      "throw with a structured error code before any state mutation.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        token: { type: "string" },
        signer_email: { type: "string" },
        signer_name: { type: "string" },
        require_hash: { type: "string", description: "Expected document SHA-256 (hex)." },
        require_title: { type: "string", description: "Regex the request title must match." },
        require_signer_email: { type: "string", description: "Expected signer email (sanity check on the token)." },
      },
      required: ["request_id", "token"],
    },
    outputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        providerRequestId: { type: "string" },
        signerEmail: { type: "string" },
        signerName: { type: "string" },
        signedAt: { type: "string" },
        requestStatus: { type: "string" },
        signedBy: {
          type: "array",
          items: {
            type: "object",
            properties: { email: { type: "string" }, name: { type: "string" }, signedAt: { type: "string" } },
          },
        },
        totalSigners: { type: "number" },
        remainingSigners: { type: "number" },
        idempotent: { type: "boolean" },
      },
    },
    handler: (db, args) =>
      signSigningRequest(db, {
        requestId: requiredStr(args, "request_id"),
        token: requiredStr(args, "token"),
        signerEmail: str(args, "signer_email"),
        signerName: str(args, "signer_name"),
        requireHash: str(args, "require_hash"),
        requireTitle: str(args, "require_title"),
        requireSignerEmail: str(args, "require_signer_email"),
      }),
  },
  {
    name: "signer_decline",
    description: "Decline a local signing request as the holder of the given token. Sets status to declined.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        token: { type: "string" },
        signer_email: { type: "string" },
        reason: { type: "string" },
      },
      required: ["request_id", "token"],
    },
    outputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        signerEmail: { type: "string" },
        declinedAt: { type: "string" },
        reason: { type: ["string", "null"] },
        status: { type: "string" },
      },
    },
    handler: (db, args) =>
      declineSigningRequestAsSigner(db, {
        requestId: requiredStr(args, "request_id"),
        token: requiredStr(args, "token"),
        signerEmail: str(args, "signer_email"),
        reason: str(args, "reason"),
      }),
  },
  {
    name: "request_show",
    description:
      "Return the enriched request snapshot: request, approvals (with tokenHint/expiresAt/expired/signed), " +
      "signedBy[], declinedBy/declineReason, and a nextSteps[] array of suggested commands.",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        request: { type: "object" },
        approvals: { type: "array" },
        signedBy: { type: "array" },
        declinedBy: { type: ["string", "null"] },
        nextSteps: { type: "array", items: { type: "string" } },
      },
    },
    handler: (db, args) => getRequestSnapshot(db, requiredStr(args, "request_id")),
  },
  {
    name: "request_status",
    description:
      "Poll the provider for the latest status of a request. For dropbox/signwell, reads API keys " +
      "from DROPBOX_SIGN_API_KEY / SIGNWELL_API_KEY in the server's environment.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        provider: { type: "string", enum: ["dropbox", "docusign", "signwell", "local"] },
      },
      required: ["request_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        provider: { type: "string" },
        status: { type: "string" },
        providerStatus: { type: ["string", "null"] },
        terminal: { type: ["string", "null"] },
      },
    },
    handler: async (db, args) => {
      const provider = resolveProviderArg(args);
      return getSigningRequestStatus(db, {
        requestId: requiredStr(args, "request_id"),
        provider,
        apiKey: providerApiKey(provider),
      });
    },
  },
  {
    name: "audit_verify",
    description: "Verify the cryptographic audit chain for a request and report any break.",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        valid: { type: "boolean" },
        events: { type: "number" },
        break: { type: ["object", "null"] },
      },
    },
    handler: (db, args) => verifyRequestAuditChain(db, requiredStr(args, "request_id")),
  },
  {
    name: "request_watch",
    description:
      "Poll a request's status until terminal (completed/declined/canceled/timeout). " +
      "When the MCP client supplies a progressToken, emits notifications/progress on each poll.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        provider: { type: "string", enum: ["dropbox", "docusign", "signwell", "local"] },
        interval_ms: { type: "number" },
        timeout_ms: { type: "number" },
      },
      required: ["request_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        terminal: { type: ["string", "null"] },
        attempts: { type: "number" },
        finalStatus: { type: "string" },
      },
    },
    // Progress notifications: one per poll cycle. `progress` is the 1-based
    // attempt number; `message` is "<status>" or "<status> (terminal=<reason>)"
    // when the watch hits a terminal state.
    progressSchema: {
      type: "object",
      properties: {
        progress: { type: "number", description: "1-based poll attempt." },
        total: { type: "number" },
        message: { type: "string", description: "<status>[ (terminal=<reason>)]" },
      },
      required: ["progress", "message"],
    },
    handler: async (db, args, ctx) => {
      const provider = resolveProviderArg(args);
      const intervalMs = typeof args.interval_ms === "number" ? args.interval_ms : 1000;
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 30_000;
      // Validate here so the error is worded in MCP arg names and carries a
      // structured INVALID_ARGS code (the underlying watcher throws too, but
      // its message references the CLI flag names).
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new SignCliError({ code: "INVALID_ARGS", message: "interval_ms must be a positive number." });
      }
      if (typeof args.timeout_ms === "number" && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw new SignCliError({ code: "INVALID_ARGS", message: "timeout_ms must be a positive number when provided." });
      }
      return watchSigningRequestStatus(db, {
        requestId: requiredStr(args, "request_id"),
        provider,
        apiKey: providerApiKey(provider),
        intervalMs,
        timeoutMs,
        onPoll: ctx.emitProgress
          ? (update) =>
              ctx.emitProgress!({
                progress: update.attempt,
                message: `${update.status}${update.terminal ? ` (terminal=${update.terminal})` : ""}`,
              })
          : undefined,
      });
    },
  },
  // ─── New surfaces shipped 2026-05-13 ─────────────────────────────────────
  // Read-only detection tools — expose pdfjs-driven anchor detection so agents
  // can introspect a PDF before deciding what to do.
  {
    name: "pdf_detect_signature_field",
    description:
      "Detect signature-field placement candidates in a PDF (AcroForm /Sig widgets + anchor-text matches). " +
      "Returns ranked candidates with confidence + adjustment method. Read-only — does not modify the PDF.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_path: { type: "string", description: "Path to the PDF to inspect." },
        verbose: { type: "boolean", description: "When true, include raw pdfjs text items per page for debugging." },
      },
      required: ["pdf_path"],
    },
    outputSchema: {
      type: "object",
      properties: {
        pageCount: { type: "number" },
        acroFormFields: { type: "number" },
        anchorMatches: { type: "number" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              page: { type: "number" }, x: { type: "number" }, y: { type: "number" },
              width: { type: "number" }, height: { type: "number" },
              source: { type: "string" }, confidence: { type: "number" },
              adjustedFrom: { type: ["string", "null"] },
              category: { type: "string", enum: ["signature", "date"] },
              alreadyFilled: { type: ["boolean", "null"] },
            },
          },
        },
      },
    },
    handler: async (_db, args) => {
      const { readFileSync } = await import("node:fs");
      const { validateDocumentPath } = await import("./validate.js");
      const { detectSignatureFields } = await import("./signature-field-detection.js");
      const verbose = Boolean(args.verbose);
      const pdfPath = requiredStr(args, "pdf_path");
      validateDocumentPath(pdfPath);
      const detection = await detectSignatureFields(readFileSync(pdfPath), { verbose });
      // Return only signature candidates here (mirrors `sign pdf detect-signature-field` CLI behavior).
      return {
        pageCount: detection.pageCount,
        acroFormFields: detection.acroFormFields,
        anchorMatches: detection.signatureCandidates.length,
        candidates: detection.signatureCandidates,
        ...(verbose ? { textItemsByPage: detection.textItemsByPage, pageDimensions: detection.pageDimensions } : {}),
      };
    },
  },
  {
    name: "pdf_detect_date_field",
    description:
      "Detect date-field placement candidates in a PDF. Returns candidates with `alreadyFilled: true` when " +
      "a date string is already present near the anchor — callers can skip those when stamping. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_path: { type: "string", description: "Path to the PDF to inspect." },
        verbose: { type: "boolean", description: "When true, include raw pdfjs text items per page." },
      },
      required: ["pdf_path"],
    },
    outputSchema: {
      type: "object",
      properties: {
        pageCount: { type: "number" },
        anchorMatches: { type: "number" },
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              page: { type: "number" }, x: { type: "number" }, y: { type: "number" },
              width: { type: "number" }, height: { type: "number" },
              source: { type: "string" }, confidence: { type: "number" },
              adjustedFrom: { type: ["string", "null"] },
              category: { type: "string", enum: ["date"] },
              alreadyFilled: { type: ["boolean", "null"] },
            },
          },
        },
      },
    },
    handler: async (_db, args) => {
      const { readFileSync } = await import("node:fs");
      const { validateDocumentPath } = await import("./validate.js");
      const { detectSignatureFields } = await import("./signature-field-detection.js");
      const verbose = Boolean(args.verbose);
      const pdfPath = requiredStr(args, "pdf_path");
      validateDocumentPath(pdfPath);
      const detection = await detectSignatureFields(readFileSync(pdfPath), { verbose });
      return {
        pageCount: detection.pageCount,
        anchorMatches: detection.dateCandidates.length,
        candidates: detection.dateCandidates,
        ...(verbose ? { textItemsByPage: detection.textItemsByPage, pageDimensions: detection.pageDimensions } : {}),
      };
    },
  },
  // Inspect signatures on any PADES-signed PDF — read-only.
  {
    name: "pdf_inspect_signatures",
    description:
      "Inspect existing PADES signatures on ANY PDF — ours, Adobe's, DocuSign's, Dropbox Sign's, SignWell's. " +
      "Returns per-signature signer CN/email, cert subject + issuer, validity window, fingerprint, " +
      "trust label (self_signed_local | self_signed_other | ca_signed | unknown), message-digest match, " +
      "and parse warnings. Trust label is structural (issuer vs subject); no chain validation, no expiry check. " +
      "Pure read — no DB interaction, no audit events.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_path: { type: "string", description: "Path to the PDF to inspect." },
      },
      required: ["pdf_path"],
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        fileSize: { type: "number" },
        signatureCount: { type: "number" },
        hasSignature: { type: "boolean" },
        signatures: { type: "array" },
        warnings: { type: "array", items: { type: "string" } },
      },
    },
    handler: async (_db, args) => {
      const { validateDocumentPath } = await import("./validate.js");
      const { inspectPdfSignatures } = await import("./pdf-signature.js");
      const pdfPath = requiredStr(args, "pdf_path");
      validateDocumentPath(pdfPath);
      return inspectPdfSignatures(pdfPath);
    },
  },
  // Profile inspection — read-only.
  {
    name: "profile_list",
    description:
      "List the profiles configured in the user's profiles.json. Shows the active source so the agent " +
      "knows whether a flag, env var, or default selected the currently-active profile.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        userFilePath: { type: "string" },
        defaultProfile: { type: ["string", "null"] },
        profiles: { type: "array", items: { type: "string" } },
        projectFile: { type: ["string", "null"] },
        active: { type: "object" },
      },
    },
    handler: async () => {
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
  },
  {
    name: "profile_show",
    description:
      "Show the resolved active profile (or a specific user profile by name) with per-field provenance. " +
      "Credentials are redacted by default; pass show_secrets: true to reveal resolved values. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Show a specific user profile by name; omit for the active resolved view." },
        show_secrets: { type: "boolean", description: "Pass true to reveal resolved credential values." },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        active: { type: "object" },
        fields: { type: "object" },
        credentials: { type: ["object", "null"] },
      },
    },
    handler: async (_db, args, toolCtx) => {
      const { defaultUserFilePath, loadProfileContext, readUserFile, redactCredentials, resolveProfileView } =
        await import("./profiles.js");
      const userFilePath = defaultUserFilePath();
      const showSecrets = Boolean(args.show_secrets);
      // Refuse to return plaintext provider API keys unless the transport is
      // trusted (stdio, or HTTP behind a bearer auth token). Prevents an
      // unauthenticated network client from exfiltrating credentials via
      // profile_show {show_secrets:true}.
      if (showSecrets && toolCtx.secretsAllowed !== true) {
        throw new SignCliError({
          code: "FORBIDDEN",
          message: "profile_show show_secrets=true is refused on this transport.",
          hint: "Run the MCP server over stdio, or set --http-auth-token to require bearer auth before requesting secrets.",
        });
      }
      const name = str(args, "name");
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
  },
  // Mutating stamp/sign tools. Mirror the CLI handlers in src/cli.ts for
  // `sign pdf stamp-text`, `sign preview`, and `sign document`. Same flag
  // shape, same output envelope.
  {
    name: "pdf_stamp_text",
    description:
      "Stamp a text string (e.g. a date) onto a PDF. Mirrors `sign pdf stamp-text`. " +
      "Position via auto_place (true|first|last|all|page:N|index:N) on DATE anchors, " +
      "or explicit image_page/image_x/image_y/image_width/image_height. By default, " +
      "candidates whose date appears already filled in are skipped — pass overwrite_filled: true to include them. " +
      "Writes to out_path and returns the actual stamp positions + quality warnings.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_path: { type: "string", description: "Path to the PDF to stamp." },
        text: { type: "string", description: "Text to stamp (typically a date string)." },
        out_path: { type: "string", description: "Path to write the stamped PDF." },
        auto_place: { type: "string", description: "Auto-place mode: true|first|last|all|page:N|index:N." },
        overwrite_filled: { type: "boolean", description: "When true, include already-filled date candidates." },
        image_page: { type: "number", description: "1-indexed page (with explicit coords)." },
        image_x: { type: "number" },
        image_y: { type: "number" },
        image_width: { type: "number" },
        image_height: { type: "number" },
      },
      required: ["pdf_path", "text", "out_path"],
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        pdf: { type: "string" },
        out: { type: "string" },
        text: { type: "string" },
        positions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              page: { type: "number" }, x: { type: "number" }, y: { type: "number" },
              width: { type: "number" }, height: { type: "number" },
            },
          },
        },
        bytes: { type: "number" },
        warnings: { type: "array" },
      },
    },
    handler: async (_db, args) => {
      const { readFileSync, writeFileSync } = await import("node:fs");
      const { validateDocumentPath, validateOutputPath } = await import("./validate.js");
      const { parseAutoPlaceMode, selectAutoPlaceCandidates, InvalidAutoPlaceValue } =
        await import("./auto-place-selector.js");
      const { detectSignatureFields } = await import("./signature-field-detection.js");
      const { stampPlainTextOnPdf } = await import("./pdf-image-stamp.js");
      const { assessStampQuality } = await import("./stamp-quality.js");

      const pdfPath = requiredStr(args, "pdf_path");
      validateDocumentPath(pdfPath);
      const text = requiredStr(args, "text");
      const outPath = validateOutputPath(requiredStr(args, "out_path"));
      const overwriteFilled = Boolean(args.overwrite_filled);

      let pdfBytes: Buffer = readFileSync(pdfPath);
      const explicit = {
        page: typeof args.image_page === "number" ? args.image_page : undefined,
        x: typeof args.image_x === "number" ? args.image_x : undefined,
        y: typeof args.image_y === "number" ? args.image_y : undefined,
        width: typeof args.image_width === "number" ? args.image_width : undefined,
        height: typeof args.image_height === "number" ? args.image_height : undefined,
      };
      const explicitComplete =
        explicit.page !== undefined && explicit.x !== undefined && explicit.y !== undefined &&
        explicit.width !== undefined && explicit.height !== undefined;

      let mode;
      try {
        mode = parseAutoPlaceMode(str(args, "auto_place"));
      } catch (err) {
        if (err instanceof InvalidAutoPlaceValue) {
          throw new SignCliError({ code: "INVALID_AUTO_PLACE_VALUE", message: err.message, hint: err.hint });
        }
        throw err;
      }

      let primary: { page: number; x: number; y: number; width: number; height: number } | undefined;
      let extras: Array<{ page: number; x: number; y: number; width: number; height: number }> = [];
      if (explicitComplete) {
        primary = { page: explicit.page!, x: explicit.x!, y: explicit.y!, width: explicit.width!, height: explicit.height! };
      } else if (mode.kind !== "none") {
        const detection = await detectSignatureFields(pdfBytes);
        const datePool = overwriteFilled
          ? detection.dateCandidates
          : detection.dateCandidates.filter((c) => !c.alreadyFilled);
        const result = selectAutoPlaceCandidates(datePool, mode);
        if (!result.ok) {
          const skippedFilled =
            !overwriteFilled &&
            datePool.length === 0 &&
            detection.dateCandidates.some((c) => c.alreadyFilled);
          throw new SignCliError({
            code: result.errorCode,
            message: result.message,
            hint: skippedFilled
              ? `Date candidate(s) were skipped because a date appears already filled in nearby. Pass overwrite_filled: true to include them.`
              : result.hint,
            details: { candidates: datePool, allDateCandidates: detection.dateCandidates },
          });
        }
        const [first, ...rest] = result.chosen;
        primary = { page: first.page, x: first.x, y: first.y, width: first.width, height: first.height };
        extras = rest.map((c) => ({ page: c.page, x: c.x, y: c.y, width: c.width, height: c.height }));
      }
      if (!primary) {
        throw new SignCliError({
          code: "MISSING_FLAG",
          message: "pdf_stamp_text requires a position: pass auto_place, or all of image_page/image_x/image_y/image_width/image_height.",
        });
      }

      const positions = [primary, ...extras];
      for (const pos of positions) {
        pdfBytes = await stampPlainTextOnPdf(pdfBytes, text, pos);
      }
      writeFileSync(outPath, pdfBytes);

      const warnings = [];
      for (const pos of positions) {
        warnings.push(...(await assessStampQuality({
          pdfBytes, page: pos.page, x: pos.x, y: pos.y, width: pos.width, height: pos.height,
        })));
      }
      return { ok: true, pdf: pdfPath, out: outPath, text, positions, bytes: pdfBytes.length, warnings };
    },
  },
  {
    name: "preview",
    description:
      "Stamp a signature image or rendered name onto a PDF as a draft preview — NO PAdES seal, " +
      "no signing-request state mutation. Mirrors `sign preview`. Returns positions + drawnRects " +
      "(actual on-page rectangles after preserve-aspect-ratio shrink-to-fit) + warnings.",
    inputSchema: {
      type: "object",
      properties: {
        pdf_path: { type: "string" },
        out_path: { type: "string" },
        signature_image: { type: "string", description: "File path OR data:image/(png|jpeg|svg+xml);base64,... URL." },
        name_signature: { type: "string", description: "Render this string as a stylized name stamp." },
        auto_place: { type: "string", description: "true|first|last|all|page:N|index:N. Uses signature anchors." },
        preserve_aspect_ratio: { type: "boolean" },
        auto_crop: { type: "boolean" },
        image_page: { type: "number" },
        image_x: { type: "number" },
        image_y: { type: "number" },
        image_width: { type: "number" },
        image_height: { type: "number" },
      },
      required: ["pdf_path", "out_path"],
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        pdf: { type: "string" },
        out: { type: "string" },
        positions: { type: "array" },
        drawnRects: { type: "array" },
        bytes: { type: "number" },
        sealed: { type: "boolean" },
        stampOptions: { type: "object" },
        warnings: { type: "array" },
      },
    },
    handler: async (_db, args) => {
      const { readFileSync, writeFileSync } = await import("node:fs");
      const { validateDocumentPath, validateOutputPath } = await import("./validate.js");
      const { parseImageInput, stampImageOnPdf } = await import("./pdf-image-stamp.js");
      const { stampTextOnPdf } = await import("./pdf-image-stamp.js");
      const { parseAutoPlaceMode, selectAutoPlaceCandidates, InvalidAutoPlaceValue } =
        await import("./auto-place-selector.js");
      const { detectSignatureFields } = await import("./signature-field-detection.js");
      const { assessStampQuality } = await import("./stamp-quality.js");
      const { verifyPdfStamp } = await import("./pdf-stamp-verify.js");

      const pdfPath = requiredStr(args, "pdf_path");
      validateDocumentPath(pdfPath);
      const outPath = validateOutputPath(requiredStr(args, "out_path"));
      const imageFlag = str(args, "signature_image");
      const nameSig = str(args, "name_signature");
      if (!imageFlag && !nameSig) {
        throw new SignCliError({
          code: "MISSING_FLAG",
          message: "preview requires signature_image or name_signature.",
          hint: "Pass signature_image (path or data: URL) or name_signature (rendered text).",
        });
      }
      if (imageFlag && nameSig) {
        throw new SignCliError({
          code: "SIGN_VISIBLE_SIG_BOTH",
          message: "signature_image and name_signature are mutually exclusive.",
          hint: "Pick one for the preview.",
        });
      }

      let pdfBytes: Buffer = readFileSync(pdfPath);

      const explicit = {
        page: typeof args.image_page === "number" ? args.image_page : undefined,
        x: typeof args.image_x === "number" ? args.image_x : undefined,
        y: typeof args.image_y === "number" ? args.image_y : undefined,
        width: typeof args.image_width === "number" ? args.image_width : undefined,
        height: typeof args.image_height === "number" ? args.image_height : undefined,
      };
      const explicitComplete =
        explicit.page !== undefined && explicit.x !== undefined && explicit.y !== undefined &&
        explicit.width !== undefined && explicit.height !== undefined;

      let mode;
      try {
        mode = parseAutoPlaceMode(str(args, "auto_place"));
      } catch (err) {
        if (err instanceof InvalidAutoPlaceValue) {
          throw new SignCliError({ code: "INVALID_AUTO_PLACE_VALUE", message: err.message, hint: err.hint });
        }
        throw err;
      }

      let primary: { page: number; x: number; y: number; width: number; height: number } | undefined;
      let extras: Array<{ page: number; x: number; y: number; width: number; height: number }> = [];
      if (explicitComplete) {
        primary = { page: explicit.page!, x: explicit.x!, y: explicit.y!, width: explicit.width!, height: explicit.height! };
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
        throw new SignCliError({
          code: "MISSING_FLAG",
          message: "preview requires a stamp position: pass auto_place, or all of image_page/image_x/image_y/image_width/image_height.",
        });
      }

      const stampOptions = {
        ...(typeof args.preserve_aspect_ratio === "boolean" ? { preserveAspectRatio: args.preserve_aspect_ratio } : {}),
        ...(typeof args.auto_crop === "boolean" ? { autoCrop: args.auto_crop } : {}),
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
        warnings.push(...(await assessStampQuality({
          pdfBytes, page: pos.page, x: pos.x, y: pos.y, width: pos.width, height: pos.height,
        })));
        const probe = await verifyPdfStamp(pdfBytes, pos);
        if (probe.found) {
          drawnRects.push({
            page: probe.found.page, x: probe.found.x, y: probe.found.y,
            width: probe.found.width, height: probe.found.height,
          });
        }
      }
      return {
        ok: true, pdf: pdfPath, out: outPath, positions, drawnRects,
        bytes: pdfBytes.length, sealed: false, stampOptions, warnings,
      };
    },
  },
  {
    name: "document",
    description:
      "One-shot DOCX|PDF → signed PDF. Mirrors `sign document`. Orchestrates DOCX→PDF " +
      "(via docx2pdf-cli) → auto-place detection → stamp + PAdES seal → verify. Uses an " +
      "isolated temp database so the caller's main db is never touched. Defaults auto_place to 'first'.",
    inputSchema: {
      type: "object",
      properties: {
        input_path: { type: "string", description: "Path to .docx/.doc/.odt/.rtf/.pdf input." },
        out_path: { type: "string", description: "Where to write the final sealed PDF." },
        signer_name: { type: "string", description: "Signer's full name." },
        signer_email: { type: "string", description: "Optional. Defaults to slug@local.invalid." },
        title: { type: "string", description: "Optional title. Defaults to basename of input_path." },
        signature_image: { type: "string", description: "File path OR data:image/...;base64,... URL." },
        name_signature: { type: "string", description: "Render this string as a stylized name stamp." },
        auto_place: { type: "string", description: "true|first|last|all|page:N|index:N (default first)." },
        preserve_aspect_ratio: { type: "boolean" },
        auto_crop: { type: "boolean" },
        image_page: { type: "number" },
        image_x: { type: "number" },
        image_y: { type: "number" },
        image_width: { type: "number" },
        image_height: { type: "number" },
      },
      required: ["input_path", "out_path", "signer_name"],
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        input: { type: "string" },
        output: { type: "string" },
        bytes: { type: "number" },
        converted: { type: "boolean" },
        converterBackend: { type: "string" },
        signedAt: { type: "string" },
        placements: { type: "array" },
        drawnRects: { type: "array" },
        warnings: { type: "array" },
        verify: {
          type: "object",
          properties: {
            chainValid: { type: "boolean" },
            events: { type: "number" },
            signers: { type: "number" },
          },
        },
      },
    },
    handler: async (_db, args) => {
      const { validateDocumentPath, validateOutputPath } = await import("./validate.js");
      const { parseImageInput } = await import("./pdf-image-stamp.js");
      const { parseAutoPlaceMode, InvalidAutoPlaceValue } = await import("./auto-place-selector.js");
      const { signDocumentOneShot } = await import("./sign-document.js");

      const inputPath = requiredStr(args, "input_path");
      validateDocumentPath(inputPath);
      const outPath = validateOutputPath(requiredStr(args, "out_path"));
      const signerName = requiredStr(args, "signer_name");
      const signatureImage = str(args, "signature_image");
      const nameSig = str(args, "name_signature");

      let autoPlaceMode;
      try {
        autoPlaceMode = parseAutoPlaceMode(str(args, "auto_place"));
      } catch (err) {
        if (err instanceof InvalidAutoPlaceValue) {
          throw new SignCliError({ code: "INVALID_AUTO_PLACE_VALUE", message: err.message, hint: err.hint });
        }
        throw err;
      }

      const explicit = {
        page: typeof args.image_page === "number" ? args.image_page : undefined,
        x: typeof args.image_x === "number" ? args.image_x : undefined,
        y: typeof args.image_y === "number" ? args.image_y : undefined,
        width: typeof args.image_width === "number" ? args.image_width : undefined,
        height: typeof args.image_height === "number" ? args.image_height : undefined,
      };
      const explicitComplete =
        explicit.page !== undefined && explicit.x !== undefined && explicit.y !== undefined &&
        explicit.width !== undefined && explicit.height !== undefined;

      // Same default as the CLI: "first" when no explicit coords + no auto_place flag.
      if (autoPlaceMode.kind === "none" && !explicitComplete) {
        autoPlaceMode = { kind: "first" } as const;
      }

      const result = await signDocumentOneShot({
        inputPath,
        outPath,
        signerName,
        ...(str(args, "signer_email") ? { signerEmail: str(args, "signer_email") } : {}),
        ...(str(args, "title") ? { title: str(args, "title") } : {}),
        ...(signatureImage ? { signatureImage: parseImageInput(signatureImage) } : {}),
        ...(nameSig ? { nameSignatureText: nameSig } : {}),
        autoPlaceMode,
        ...(explicitComplete ? { imagePosition: {
          page: explicit.page!, x: explicit.x!, y: explicit.y!,
          width: explicit.width!, height: explicit.height!,
        } } : {}),
        ...(signatureImage ? { signatureImageOptions: {
          ...(typeof args.preserve_aspect_ratio === "boolean" ? { preserveAspectRatio: args.preserve_aspect_ratio } : {}),
          ...(typeof args.auto_crop === "boolean" ? { autoCrop: args.auto_crop } : {}),
        } } : {}),
      });
      return result;
    },
  },
  // ─── Parity with HTTP API: signer_reissue_token, audit_scan, request_receipt ─
  {
    name: "signer_reissue_token",
    description:
      "Mint a new per-signer token for an existing request; the previous token is invalidated. " +
      "Use when a signer lost their original token or it's about to expire. Mutating.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        signer_email: { type: "string" },
        token_ttl_minutes: { type: "number", description: "Optional TTL override; uses request default when omitted." },
      },
      required: ["request_id", "signer_email"],
    },
    outputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        signerEmail: { type: "string" },
        token: { type: "string" },
        tokenHint: { type: "string" },
        expiresAt: { type: "string" },
      },
    },
    handler: (db, args) =>
      reissueSignerToken(db, {
        requestId: requiredStr(args, "request_id"),
        signerEmail: requiredStr(args, "signer_email"),
        ...(typeof args.token_ttl_minutes === "number" ? { tokenTtlMinutes: args.token_ttl_minutes } : {}),
      }),
  },
  {
    name: "audit_scan",
    description:
      "Verify the audit chain of every request in the local DB (or filtered by provider/status). " +
      "Returns per-request validity and any chain break. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", enum: ["dropbox", "docusign", "signwell", "local"] },
        status: { type: "string", description: "Filter to a specific request status (e.g. 'completed')." },
        limit: { type: "number" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number" },
        valid: { type: "number" },
        invalid: { type: "number" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              requestId: { type: "string" },
              title: { type: "string" },
              status: { type: "string" },
              valid: { type: "boolean" },
              events: { type: "number" },
              break: { type: ["object", "null"] },
            },
          },
        },
      },
    },
    handler: (db, args) =>
      scanAllAuditChains(db, {
        provider: resolveProviderArg(args),
        ...(str(args, "status") ? { status: str(args, "status") } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      }),
  },
  {
    name: "request_receipt",
    description:
      "Export a cryptographically-signed receipt bundle for a request: audit.json, signed.pdf, " +
      "manifest.json, manifest.sig (RSA-SHA256 over manifest.json), manifest.cert.pem. " +
      "Verifiable end-to-end with `sign request verify-receipt`. Mutating (writes to out_dir).",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        out_dir: { type: "string", description: "Directory to write the bundle (must pass validateOutputPath)." },
      },
      required: ["request_id", "out_dir"],
    },
    // Mirrors ReceiptResult in signing-service.ts. The cert key on disk is
    // `manifest.cert.pem` but the result field is `certPath`; the manifest's
    // SHA-256 is `manifestSha256` (NOT `manifestHash`). `files` is an array
    // of { name, sha256, bytes } objects — every artifact in the bundle.
    outputSchema: {
      type: "object",
      properties: {
        outDir: { type: "string" },
        manifestPath: { type: "string" },
        manifestSha256: { type: "string" },
        signaturePath: { type: "string" },
        signatureBytes: { type: "number" },
        certPath: { type: "string" },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              sha256: { type: "string" },
              bytes: { type: "number" },
            },
          },
        },
        chain: {
          type: "object",
          properties: {
            valid: { type: "boolean" },
            events: { type: "number" },
            break: { type: ["object", "null"] },
          },
        },
      },
    },
    handler: async (db, args) => {
      const { validateOutputPath } = await import("./validate.js");
      return exportRequestReceipt(db, {
        requestId: requiredStr(args, "request_id"),
        outDir: validateOutputPath(requiredStr(args, "out_dir")),
      });
    },
  },
];

function validateToolArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || value === "") {
      return { ok: false, error: `Missing required argument: ${key}` };
    }
  }
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!propSchema) continue;
    const expectedType = propSchema.type;
    if (expectedType === "string" && typeof value !== "string") {
      return { ok: false, error: `Argument ${key} must be a string.` };
    }
    if (expectedType === "number" && typeof value !== "number") {
      return { ok: false, error: `Argument ${key} must be a number.` };
    }
    if (expectedType === "boolean" && typeof value !== "boolean") {
      return { ok: false, error: `Argument ${key} must be a boolean.` };
    }
    if (Array.isArray(propSchema.enum)) {
      const allowed = propSchema.enum as unknown[];
      if (!allowed.includes(value)) {
        return { ok: false, error: `Argument ${key} must be one of: ${allowed.join(", ")}` };
      }
    }
  }
  return { ok: true };
}

export function listMcpTools(): Array<Pick<ToolDefinition, "name" | "description" | "inputSchema" | "outputSchema" | "progressSchema">> {
  return TOOLS.map(({ name, description, inputSchema, outputSchema, progressSchema }) => ({
    name,
    description,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    ...(progressSchema ? { progressSchema } : {}),
  }));
}

// Markdown renderer for the tools catalog. Useful for `sign mcp tools --format markdown`
// when generating docs for non-MCP clients building generic agent loops.
export function renderMcpToolsAsMarkdown(): string {
  const tools = listMcpTools();
  const lines: string[] = ["# MCP tools", "", `Sign-cli exposes ${tools.length} MCP tools. Each tool has a JSON-Schema input contract; tools that return a structured response also expose an outputSchema.`, ""];
  for (const tool of tools) {
    lines.push(`## \`${tool.name}\``);
    lines.push("");
    lines.push(tool.description);
    lines.push("");
    lines.push("### Input");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(tool.inputSchema, null, 2));
    lines.push("```");
    lines.push("");
    if (tool.outputSchema) {
      lines.push("### Output");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(tool.outputSchema, null, 2));
      lines.push("```");
      lines.push("");
    }
    if (tool.progressSchema) {
      lines.push("### Progress notifications");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(tool.progressSchema, null, 2));
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

type ResourceUriParts = { kind: "snapshot" | "document" | "audit"; requestId: string };

function parseResourceUri(uri: string): ResourceUriParts {
  if (!uri.startsWith("request://")) {
    throw new SignCliError({
      code: "UNKNOWN_RESOURCE",
      message: `Unknown resource URI scheme: ${uri}`,
      hint: "Resources are exposed under request://<request-id>[/document|/audit].",
    });
  }
  const path = uri.slice("request://".length);
  const [requestId, leaf] = path.split("/", 2);
  if (!requestId) {
    throw new SignCliError({
      code: "UNKNOWN_RESOURCE",
      message: `Resource URI missing request id: ${uri}`,
    });
  }
  if (!leaf) return { kind: "snapshot", requestId };
  if (leaf === "document") return { kind: "document", requestId };
  if (leaf === "audit") return { kind: "audit", requestId };
  throw new SignCliError({
    code: "UNKNOWN_RESOURCE",
    message: `Unknown resource leaf "${leaf}" for request ${requestId}.`,
    hint: "Use request://<id>, request://<id>/document, or request://<id>/audit.",
  });
}

function listMcpResources(db: SqliteDb): Array<{ uri: string; name: string; description: string; mimeType: string }> {
  const rows = listSigningRequests(db, { provider: "local", limit: 200 });
  const resources: Array<{ uri: string; name: string; description: string; mimeType: string }> = [];
  for (const row of rows) {
    resources.push({
      uri: `request://${row.id}`,
      name: `Snapshot — ${row.title}`,
      description: `Enriched request snapshot (status=${row.status}, signers=${row.signers}).`,
      mimeType: "application/json",
    });
    resources.push({
      uri: `request://${row.id}/document`,
      name: `Unsigned PDF — ${row.title}`,
      description: "Unsigned source PDF for the request (base64-encoded).",
      mimeType: "application/pdf",
    });
    resources.push({
      uri: `request://${row.id}/audit`,
      name: `Audit chain — ${row.title}`,
      description: "Append-only hash-chained audit events for this request.",
      mimeType: "application/json",
    });
  }
  return resources;
}

function readMcpResource(db: SqliteDb, uri: string): { uri: string; mimeType: string; text?: string; blob?: string } {
  const parts = parseResourceUri(uri);
  if (parts.kind === "snapshot") {
    const snap = getRequestSnapshot(db, parts.requestId);
    return { uri, mimeType: "application/json", text: JSON.stringify(snap, null, 2) };
  }
  if (parts.kind === "audit") {
    const events = listAuditEvents(db, parts.requestId);
    return { uri, mimeType: "application/json", text: JSON.stringify(events, null, 2) };
  }
  // document
  const doc = readLocalDocumentForResource(db, parts.requestId);
  return { uri, mimeType: "application/pdf", blob: doc.pdf.toString("base64") };
}

export type McpDispatchInput = {
  method: string;
  params?: unknown;
  db: SqliteDb;
  emitProgress?: McpEmitProgress;
  // When true, tools/call refuses the lifecycle-mutating tools with a
  // FORBIDDEN_READ_ONLY error envelope (same code shape as the HTTP
  // --read-only path).
  readOnly?: boolean;
  // When set, ONLY the named tools are exposed via tools/list and tools/call.
  // Anything outside the set returns isError + UNKNOWN_TOOL — same envelope
  // shape as a real unknown tool, so an agent can't probe the server for
  // hidden capabilities.
  allowedTools?: ReadonlySet<string>;
  // When set, only these capabilities are advertised at initialize and the
  // matching list/read methods are answered. Disabled capabilities respond
  // with a JSON-RPC method-not-found shaped error envelope.
  capabilities?: ReadonlySet<"tools" | "resources" | "prompts">;
  // Forwarded to ToolContext.secretsAllowed — gates plaintext-secret tool
  // outputs (profile_show show_secrets). Trusted on stdio; on HTTP only when
  // a bearer auth token is configured.
  secretsAllowed?: boolean;
};

export type McpDispatchResult = { kind: "result"; value: unknown } | { kind: "ignored" };

function capabilityDisabled(name: "tools" | "resources" | "prompts"): SignCliError {
  return new SignCliError({
    code: "INVALID_ARGS",
    message: `Capability "${name}" is disabled on this MCP server (mcp serve --capability …).`,
  });
}

// Mutating tool names. Mirrors the HTTP READ_ONLY_BLOCKED_ROUTES set scoped
// to what the MCP surface actually exposes.
export const READ_ONLY_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "sign",
  "signer_decline",
  "pdf_stamp_text",
  "preview",
  "document",
  "signer_reissue_token",
  "request_receipt",
  // signer_fetch_document is read-shaped by name but it MUTATES state: it
  // appends a request.signer_fetched_document audit row and (with out_path)
  // writes a file to disk. Block it in --read-only mode like the other
  // mutating tools.
  "signer_fetch_document",
]);

export async function dispatchMcp(input: McpDispatchInput): Promise<McpDispatchResult> {
  const { method, params, db } = input;
  const isEnabled = (cap: "tools" | "resources" | "prompts") =>
    !input.capabilities || input.capabilities.has(cap);

  if (method === "initialize") {
    const advertised: Record<string, unknown> = {};
    if (isEnabled("tools")) advertised.tools = {};
    if (isEnabled("resources")) advertised.resources = { listChanged: false, subscribe: true };
    if (isEnabled("prompts")) advertised.prompts = { listChanged: false };
    return {
      kind: "result",
      value: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: advertised,
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      },
    };
  }
  if (method === "tools/list") {
    if (!isEnabled("tools")) throw capabilityDisabled("tools");
    const tools = input.allowedTools
      ? listMcpTools().filter((t) => input.allowedTools!.has(t.name))
      : listMcpTools();
    return { kind: "result", value: { tools } };
  }
  if (method === "resources/list") {
    if (!isEnabled("resources")) throw capabilityDisabled("resources");
    return { kind: "result", value: { resources: listMcpResources(db) } };
  }
  if (method === "prompts/list") {
    if (!isEnabled("prompts")) throw capabilityDisabled("prompts");
    return { kind: "result", value: { prompts: listMcpPrompts() } };
  }
  if (method === "prompts/get") {
    if (!isEnabled("prompts")) throw capabilityDisabled("prompts");
    const params = (input.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== "string" || params.name.length === 0) {
      throw new SignCliError({
        code: "INVALID_ARGS",
        message: "prompts/get requires a string `name` parameter.",
      });
    }
    const promptArgs = (params.arguments ?? {}) as Record<string, string>;
    return { kind: "result", value: getMcpPrompt({ name: params.name, arguments: promptArgs }) };
  }
  if (method === "resources/read") {
    if (!isEnabled("resources")) throw capabilityDisabled("resources");
    const readParams = (params ?? {}) as { uri?: unknown };
    if (typeof readParams.uri !== "string" || readParams.uri.length === 0) {
      throw new SignCliError({
        code: "INVALID_ARGS",
        message: "resources/read requires a string `uri` parameter.",
      });
    }
    const content = readMcpResource(db, readParams.uri);
    return { kind: "result", value: { contents: [content] } };
  }
  if (method === "tools/call") {
    if (!isEnabled("tools")) throw capabilityDisabled("tools");
    const callParams = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const toolName = typeof callParams.name === "string" ? callParams.name : "";
    const toolArgs = (callParams.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => entry.name === toolName);
    // Allow-list gate: outside the allowed set, return the same envelope as
    // a real unknown tool so an agent can't probe for hidden capabilities.
    const allowedTools = input.allowedTools;
    if (!tool || (allowedTools && !allowedTools.has(tool.name))) {
      return {
        kind: "result",
        value: {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: { code: "UNKNOWN_TOOL", message: `Tool not found: ${toolName || "(unnamed)"}` } },
                null,
                2,
              ),
            },
          ],
          isError: true,
        },
      };
    }
    if (input.readOnly && READ_ONLY_BLOCKED_TOOLS.has(tool.name)) {
      return {
        kind: "result",
        value: {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: {
                    code: "FORBIDDEN_READ_ONLY",
                    message: `Server is running with --read-only true; tools/call for "${tool.name}" is disabled.`,
                  },
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        },
      };
    }
    const validation = validateToolArgs(tool.inputSchema, toolArgs);
    if (!validation.ok) {
      return {
        kind: "result",
        value: {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: { code: "INVALID_ARGS", message: validation.error } },
                null,
                2,
              ),
            },
          ],
          isError: true,
        },
      };
    }
    try {
      const result = await tool.handler(db, toolArgs, {
        emitProgress: input.emitProgress,
        secretsAllowed: input.secretsAllowed,
      });
      return {
        kind: "result",
        value: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      };
    } catch (error) {
      return {
        kind: "result",
        value: {
          content: [{ type: "text", text: JSON.stringify(formatCliError(error), null, 2) }],
          isError: true,
        },
      };
    }
  }
  if (
    method === "notifications/initialized" ||
    method === "notifications/cancelled" ||
    method === "ping"
  ) {
    return { kind: "ignored" };
  }
  throw new Error(`MCP method not found: ${method}`);
}

const JSON_RPC_VERSION = "2.0";

export type JsonRpcMessage = {
  jsonrpc: typeof JSON_RPC_VERSION;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function writeMessage(out: NodeJS.WritableStream, message: JsonRpcMessage): void {
  out.write(`${JSON.stringify(message)}\n`);
}

// Field names whose string values are always replaced with <REDACTED> when
// redaction is on. Matched case-insensitively. Conservative — covers the
// shapes our own MCP surface emits, plus the Authorization header form an
// agent might pass through in arguments.
const SECRET_FIELD_NAMES = new Set([
  "token",
  "token_hash",
  "token_hint",
  "authorization",
  "bearer",
  "api_key",
  "apikey",
  "x-api-key",
]);

function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && SECRET_FIELD_NAMES.has(key.toLowerCase())) {
        out[key] = "<REDACTED>";
      } else {
        out[key] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

function extractProgressToken(params: unknown): string | number | null {
  if (!params || typeof params !== "object") return null;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return null;
  const token = (meta as { progressToken?: unknown }).progressToken;
  if (typeof token === "string" || typeof token === "number") return token;
  return null;
}

export async function serveMcpStdio(opts: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  db: SqliteDb;
  readOnly?: boolean;
  allowedTools?: ReadonlySet<string>;
  capabilities?: ReadonlySet<"tools" | "resources" | "prompts">;
  // Path to append every JSON-RPC message (in and out) as NDJSON. Each line
  // is { direction: "in"|"out", at: <ISO>, message: <JSON-RPC body> }.
  // Compliance-grade replay log — pair with a strict file ACL so only the
  // operator can read/write it.
  emitEventsPath?: string;
  // When true (with emitEventsPath), token-shaped fields anywhere in the
  // message tree are replaced with "<REDACTED>" before being written to the
  // log. The wire bytes going to the client are NOT touched — only the log.
  emitEventsRedact?: boolean;
}): Promise<void> {
  const rl = readline.createInterface({ input: opts.input, crlfDelay: Infinity });
  // Optional audit log — append every JSON-RPC message (in and out) as
  // NDJSON. Wrap the output stream with a teeing writeMessage; tee inbound
  // at parse time.
  let emitStream: WriteStream | null = null;
  if (opts.emitEventsPath) {
    const resolved = path.resolve(opts.emitEventsPath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    emitStream = createWriteStream(resolved, { flags: "a" });
  }
  const redactForEmit = opts.emitEventsRedact === true;
  const renderEmit = (entry: { direction: "in" | "out"; at: string; message: JsonRpcMessage }): string =>
    JSON.stringify(redactForEmit ? { ...entry, message: redactSecrets(entry.message) } : entry) + "\n";
  const writeMessageTeed = (out: NodeJS.WritableStream, message: JsonRpcMessage): void => {
    if (emitStream) {
      emitStream.write(renderEmit({ direction: "out", at: new Date().toISOString(), message }));
    }
    writeMessage(out, message);
  };
  // Per-connection subscription registry. Each entry is the unsubscribe fn
  // returned by subscribeResource(). On stream end we drop them all.
  const subscriptions = new Map<string, () => void>();
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        writeMessageTeed(opts.output, {
          jsonrpc: JSON_RPC_VERSION,
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        continue;
      }
      if (emitStream) {
        emitStream.write(renderEmit({ direction: "in", at: new Date().toISOString(), message }));
      }
      const id = message.id ?? null;
      const isNotification = id === null || id === undefined;
      if (typeof message.method !== "string") {
        // Response from peer or malformed; ignore.
        continue;
      }
      // resources/subscribe & resources/unsubscribe are handled here (not in
      // dispatchMcp) because they need the output stream and per-connection
      // bookkeeping.
      if (message.method === "resources/subscribe" || message.method === "resources/unsubscribe") {
        const params = (message.params ?? {}) as { uri?: unknown };
        const uri = typeof params.uri === "string" ? params.uri : "";
        if (!uri) {
          if (!isNotification) {
            writeMessageTeed(opts.output, {
              jsonrpc: JSON_RPC_VERSION,
              id,
              error: { code: -32602, message: `${message.method} requires a string \`uri\` parameter.` },
            });
          }
          continue;
        }
        if (message.method === "resources/subscribe") {
          if (!subscriptions.has(uri)) {
            const unsubscribe = subscribeResource(uri, (changedUri) => {
              writeMessageTeed(opts.output, {
                jsonrpc: JSON_RPC_VERSION,
                method: "notifications/resources/updated",
                params: { uri: changedUri },
              });
            });
            subscriptions.set(uri, unsubscribe);
          }
        } else {
          const unsubscribe = subscriptions.get(uri);
          if (unsubscribe) {
            unsubscribe();
            subscriptions.delete(uri);
          }
        }
        if (!isNotification) {
          writeMessageTeed(opts.output, { jsonrpc: JSON_RPC_VERSION, id, result: {} });
        }
        continue;
      }
      const progressToken = extractProgressToken(message.params);
    const emitProgress: McpEmitProgress | undefined = progressToken !== null
      ? (progress) => {
          writeMessageTeed(opts.output, {
            jsonrpc: JSON_RPC_VERSION,
            method: "notifications/progress",
            params: { progressToken, ...progress },
          });
        }
      : undefined;
    try {
      const dispatch = await dispatchMcp({
        method: message.method,
        params: message.params,
        db: opts.db,
        emitProgress,
        readOnly: opts.readOnly,
        allowedTools: opts.allowedTools,
        capabilities: opts.capabilities,
        // stdio is a local, trusted, single-operator transport — plaintext
        // secrets are allowed here (the operator already has filesystem access
        // to the same credentials).
        secretsAllowed: true,
      });
      if (dispatch.kind === "ignored" || isNotification) continue;
      writeMessageTeed(opts.output, { jsonrpc: JSON_RPC_VERSION, id, result: dispatch.value });
      } catch (error) {
        if (isNotification) continue;
        const messageText = error instanceof Error ? error.message : String(error);
        writeMessageTeed(opts.output, {
          jsonrpc: JSON_RPC_VERSION,
          id,
          error: { code: -32601, message: messageText },
        });
      }
    }
  } finally {
    for (const unsubscribe of subscriptions.values()) {
      unsubscribe();
    }
    subscriptions.clear();
    if (emitStream) {
      await new Promise<void>((resolve) => emitStream!.end(resolve));
    }
  }
}

// Constant-time bearer-token comparison. Returns true iff `provided` matches
// `expected` exactly. Pads the shorter input to avoid leaking length, then
// uses timingSafeEqual.
function constantTimeBearerEq(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // timingSafeEqual requires equal length; pad the shorter side so we
  // always run the same number of comparisons, returning false at the end
  // if the lengths differed.
  const maxLen = Math.max(a.length, b.length);
  const padA = Buffer.concat([a, Buffer.alloc(maxLen - a.length)]);
  const padB = Buffer.concat([b, Buffer.alloc(maxLen - b.length)]);
  const sameContents = timingSafeEqual(padA, padB);
  return sameContents && a.length === b.length;
}

export type ServeMcpHttpOptions = {
  port: number;
  bind?: string;
  // Path the MCP endpoint listens on. Default "/mcp". Streamable HTTP spec
  // calls for a single endpoint; clients POST JSON-RPC bodies and read the
  // single JSON-RPC response from the body.
  endpointPath?: string;
  db: SqliteDb;
  // Optional bearer token. When set, every request to the MCP endpoint must
  // present `Authorization: Bearer <token>` or get a 401. Compared in
  // constant time.
  authToken?: string;
  readOnly?: boolean;
  allowedTools?: ReadonlySet<string>;
  capabilities?: ReadonlySet<"tools" | "resources" | "prompts">;
  // Optional NDJSON replay log of every JSON-RPC message (in + out). Same
  // shape as serveMcpStdio's emitEventsPath.
  emitEventsPath?: string;
  emitEventsRedact?: boolean;
};

// Streamable HTTP MCP transport. One POST per JSON-RPC message; response is
// the corresponding JSON-RPC message (or HTTP 202 with no body for
// notifications). CORS-open so browser-based MCP clients can connect.
// Health probe at GET / and GET /health for hosting platforms (Smithery,
// Railway, etc.) that ping the root before routing real traffic.
//
// Not implemented: SSE for server-pushed messages (resource subscribe
// updates, request_watch progress). Those clients would need to fall back
// to stdio for now. The 90% case — tools/list, tools/call, request/show,
// audit_verify — is handled here.
export function startMcpHttpServer(opts: ServeMcpHttpOptions): http.Server {
  const endpointPath = opts.endpointPath ?? "/mcp";
  // Default to loopback. Binding to 0.0.0.0 exposes the MCP endpoint to the
  // whole network; without an auth token that is an open, unauthenticated
  // control surface. Callers that intentionally want to expose it (e.g.
  // containerized hosting) must pass an explicit bind address.
  const bind = opts.bind ?? "127.0.0.1";
  let emitStream: WriteStream | null = null;
  if (opts.emitEventsPath) {
    const resolved = path.resolve(opts.emitEventsPath);
    mkdirSync(path.dirname(resolved), { recursive: true });
    emitStream = createWriteStream(resolved, { flags: "a" });
  }
  const redactForEmit = opts.emitEventsRedact === true;
  const recordEmit = (direction: "in" | "out", message: JsonRpcMessage): void => {
    if (!emitStream) return;
    const at = new Date().toISOString();
    const entry = { direction, at, message: redactForEmit ? redactSecrets(message) : message };
    emitStream.write(JSON.stringify(entry) + "\n");
  };

  const writeCorsHeaders = (res: http.ServerResponse): void => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Max-Age", "86400");
  };

  const writeJsonRpcError = (
    res: http.ServerResponse,
    id: JsonRpcMessage["id"] | undefined,
    code: number,
    message: string,
    httpStatus = 200,
  ): void => {
    const body: JsonRpcMessage = {
      jsonrpc: JSON_RPC_VERSION,
      id: id ?? null,
      error: { code, message },
    };
    recordEmit("out", body);
    writeCorsHeaders(res);
    res.setHeader("Content-Type", "application/json");
    res.statusCode = httpStatus;
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    // CORS preflight.
    if (req.method === "OPTIONS") {
      writeCorsHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    // Health probe — anything at / or /health that's not the MCP endpoint
    // returns a small JSON object so deployment platforms see a 200.
    if (req.method === "GET") {
      writeCorsHeaders(res);
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, mcp: "sign-cli", endpoint: endpointPath }));
      return;
    }

    if (req.method !== "POST") {
      writeCorsHeaders(res);
      res.statusCode = 405;
      res.setHeader("Allow", "POST, GET, OPTIONS");
      res.end();
      return;
    }

    // Path check. The Streamable HTTP spec uses a single configurable
    // endpoint — we only accept POSTs to exactly that path.
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (reqUrl.pathname !== endpointPath) {
      writeCorsHeaders(res);
      res.statusCode = 404;
      res.end();
      return;
    }

    // Optional bearer-token auth.
    if (opts.authToken) {
      const provided = req.headers.authorization;
      const prefix = "Bearer ";
      if (!provided || !provided.startsWith(prefix) || !constantTimeBearerEq(opts.authToken, provided.slice(prefix.length))) {
        writeCorsHeaders(res);
        res.statusCode = 401;
        res.setHeader("WWW-Authenticate", 'Bearer realm="sign-cli MCP"');
        res.end();
        return;
      }
    }

    // Buffer the body (small, JSON-RPC bodies are kilobytes at most).
    const chunks: Buffer[] = [];
    let total = 0;
    let bodyTooLarge = false;
    const MAX_BODY = 1024 * 1024; // 1 MiB
    req.on("data", (chunk: Buffer) => {
      if (bodyTooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY) {
        // Reply with a structured JSON-RPC error + HTTP 413 instead of
        // silently dropping the connection, so the client gets a usable
        // error rather than a hung/aborted request.
        bodyTooLarge = true;
        writeJsonRpcError(res, null, -32600, "Request body too large (max 1 MiB).", 413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (bodyTooLarge) return;
      void (async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(raw) as JsonRpcMessage;
        } catch {
          writeJsonRpcError(res, null, -32700, "Parse error");
          return;
        }
        recordEmit("in", message);

        const id = message.id;
        const isNotification = id === null || id === undefined;
        if (typeof message.method !== "string") {
          if (isNotification) {
            // Bare response — nothing to do.
            writeCorsHeaders(res);
            res.statusCode = 204;
            res.end();
            return;
          }
          writeJsonRpcError(res, id, -32600, "Invalid Request");
          return;
        }

        try {
          const dispatched = await dispatchMcp({
            method: message.method,
            params: message.params,
            db: opts.db,
            readOnly: opts.readOnly,
            allowedTools: opts.allowedTools,
            capabilities: opts.capabilities,
            // Over HTTP, plaintext secrets are only allowed when a bearer auth
            // token is configured (we reached here past the 401 gate, so the
            // caller is authenticated). Without a token the transport is open
            // and must never hand back provider keys.
            secretsAllowed: Boolean(opts.authToken),
            // emitProgress is intentionally omitted — Streamable HTTP would
            // need an SSE response for progress, which this minimal
            // implementation doesn't offer.
          });
          if (dispatched.kind === "ignored") {
            if (isNotification) {
              writeCorsHeaders(res);
              res.statusCode = 202;
              res.end();
              return;
            }
            writeJsonRpcError(res, id, -32601, `Method not found: ${message.method}`);
            return;
          }
          if (isNotification) {
            // Notifications get HTTP 202 with no body even if dispatchMcp
            // returned a result.
            writeCorsHeaders(res);
            res.statusCode = 202;
            res.end();
            return;
          }
          const body: JsonRpcMessage = {
            jsonrpc: JSON_RPC_VERSION,
            id: id ?? null,
            result: dispatched.value,
          };
          recordEmit("out", body);
          writeCorsHeaders(res);
          res.setHeader("Content-Type", "application/json");
          res.statusCode = 200;
          res.end(JSON.stringify(body));
        } catch (err: unknown) {
          const envelope = formatCliError(err);
          const errMessage = envelope.error.message;
          const errCode = envelope.error.code === "INVALID_ARGS" ? -32602 : -32603;
          writeJsonRpcError(res, id, errCode, errMessage);
        }
      })();
    });
    req.on("error", () => {
      try { res.destroy(); } catch { /* noop */ }
    });
  });

  server.listen(opts.port, bind, () => {
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : opts.port;
    process.stderr.write(
      `[sign] mcp http server listening on http://${bind}:${actualPort}${endpointPath}\n` +
      `[sign]   health: http://${bind}:${actualPort}/health\n` +
      (opts.authToken ? `[sign]   auth: bearer token required\n` : `[sign]   auth: open (set --http-auth-token to lock down)\n`) +
      (opts.readOnly ? `[sign]   read-only: mutating tools return FORBIDDEN_READ_ONLY\n` : "") +
      (opts.allowedTools ? `[sign]   tool allow-list: ${[...opts.allowedTools].join(", ")}\n` : ""),
    );
  });

  // Best-effort cleanup. emitStream gets flushed when the process exits;
  // we don't need a hook here because Node closes WriteStreams on exit.
  return server;
}
