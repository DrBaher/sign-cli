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
        signerEmail: { type: "string" },
        signedAt: { type: "string" },
        status: { type: "string" },
        signedDocumentPath: { type: ["string", "null"] },
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
  const writeMessageTeed = (out: NodeJS.WritableStream, message: JsonRpcMessage): void => {
    if (emitStream) {
      emitStream.write(JSON.stringify({ direction: "out", at: new Date().toISOString(), message }) + "\n");
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
        emitStream.write(JSON.stringify({ direction: "in", at: new Date().toISOString(), message }) + "\n");
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
