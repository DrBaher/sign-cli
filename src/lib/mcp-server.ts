import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { SqliteDb } from "./db.js";
import { resolveSignProvider, type SignProvider } from "./providers.js";
import { getMcpPrompt, listMcpPrompts } from "./mcp-prompts.js";
import { subscribeResource } from "./resource-watch.js";
import { formatCliError, SignCliError } from "./sign-error.js";
import {
  declineSigningRequestAsSigner,
  fetchUnsignedDocumentForSigner,
  getRequestSnapshot,
  getSigningRequestStatus,
  listAuditEvents,
  listSignerInbox,
  listSigningRequests,
  readLocalDocumentForResource,
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
    outputSchema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          requestId: { type: ["string", "null"] },
          title: { type: "string" },
          status: { type: "string" },
          signers: { type: "array" },
          tokens: { type: "array" },
        },
      },
    },
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
      const { detectSignatureFields } = await import("./signature-field-detection.js");
      const verbose = Boolean(args.verbose);
      const detection = await detectSignatureFields(readFileSync(requiredStr(args, "pdf_path")), { verbose });
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
      const { detectSignatureFields } = await import("./signature-field-detection.js");
      const verbose = Boolean(args.verbose);
      const detection = await detectSignatureFields(readFileSync(requiredStr(args, "pdf_path")), { verbose });
      return {
        pageCount: detection.pageCount,
        anchorMatches: detection.dateCandidates.length,
        candidates: detection.dateCandidates,
        ...(verbose ? { textItemsByPage: detection.textItemsByPage, pageDimensions: detection.pageDimensions } : {}),
      };
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
    handler: async (_db, args) => {
      const { defaultUserFilePath, loadProfileContext, readUserFile, redactCredentials, resolveProfileView } =
        await import("./profiles.js");
      const userFilePath = defaultUserFilePath();
      const showSecrets = Boolean(args.show_secrets);
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
      const { validateOutputPath } = await import("./validate.js");
      const { parseAutoPlaceMode, selectAutoPlaceCandidates, InvalidAutoPlaceValue } =
        await import("./auto-place-selector.js");
      const { detectSignatureFields } = await import("./signature-field-detection.js");
      const { stampPlainTextOnPdf } = await import("./pdf-image-stamp.js");
      const { assessStampQuality } = await import("./stamp-quality.js");

      const pdfPath = requiredStr(args, "pdf_path");
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
      const { validateOutputPath } = await import("./validate.js");
      const { parseImageInput, stampImageOnPdf } = await import("./pdf-image-stamp.js");
      const { stampTextOnPdf } = await import("./pdf-image-stamp.js");
      const { parseAutoPlaceMode, selectAutoPlaceCandidates, InvalidAutoPlaceValue } =
        await import("./auto-place-selector.js");
      const { detectSignatureFields } = await import("./signature-field-detection.js");
      const { assessStampQuality } = await import("./stamp-quality.js");
      const { verifyPdfStamp } = await import("./pdf-stamp-verify.js");

      const pdfPath = requiredStr(args, "pdf_path");
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
      const { validateOutputPath } = await import("./validate.js");
      const { parseImageInput } = await import("./pdf-image-stamp.js");
      const { parseAutoPlaceMode, InvalidAutoPlaceValue } = await import("./auto-place-selector.js");
      const { signDocumentOneShot } = await import("./sign-document.js");

      const inputPath = requiredStr(args, "input_path");
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
      const result = await tool.handler(db, toolArgs, { emitProgress: input.emitProgress });
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
