import readline from "node:readline";
import type { SqliteDb } from "./db.js";
import { resolveSignProvider, type SignProvider } from "./providers.js";
import { formatCliError } from "./sign-error.js";
import {
  declineSigningRequestAsSigner,
  fetchUnsignedDocumentForSigner,
  getRequestSnapshot,
  getSigningRequestStatus,
  listSignerInbox,
  signSigningRequest,
  verifyRequestAuditChain,
} from "./signing-service.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "sign-cli-mcp";
export const MCP_SERVER_VERSION = "0.1.0";

type ToolHandler = (db: SqliteDb, args: Record<string, unknown>) => unknown | Promise<unknown>;

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
    handler: (db, args) => verifyRequestAuditChain(db, requiredStr(args, "request_id")),
  },
];

export function listMcpTools(): Array<Pick<ToolDefinition, "name" | "description" | "inputSchema">> {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export type McpDispatchInput = {
  method: string;
  params?: unknown;
  db: SqliteDb;
};

export type McpDispatchResult = { kind: "result"; value: unknown } | { kind: "ignored" };

export async function dispatchMcp(input: McpDispatchInput): Promise<McpDispatchResult> {
  const { method, params, db } = input;
  if (method === "initialize") {
    return {
      kind: "result",
      value: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      },
    };
  }
  if (method === "tools/list") {
    return { kind: "result", value: { tools: listMcpTools() } };
  }
  if (method === "tools/call") {
    const callParams = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const toolName = typeof callParams.name === "string" ? callParams.name : "";
    const toolArgs = (callParams.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => entry.name === toolName);
    if (!tool) {
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
    try {
      const result = await tool.handler(db, toolArgs);
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

export async function serveMcpStdio(opts: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  db: SqliteDb;
}): Promise<void> {
  const rl = readline.createInterface({ input: opts.input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      writeMessage(opts.output, {
        jsonrpc: JSON_RPC_VERSION,
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      continue;
    }
    const id = message.id ?? null;
    const isNotification = id === null || id === undefined;
    if (typeof message.method !== "string") {
      // Response from peer or malformed; ignore.
      continue;
    }
    try {
      const dispatch = await dispatchMcp({ method: message.method, params: message.params, db: opts.db });
      if (dispatch.kind === "ignored" || isNotification) continue;
      writeMessage(opts.output, { jsonrpc: JSON_RPC_VERSION, id, result: dispatch.value });
    } catch (error) {
      if (isNotification) continue;
      const messageText = error instanceof Error ? error.message : String(error);
      writeMessage(opts.output, {
        jsonrpc: JSON_RPC_VERSION,
        id,
        error: { code: -32601, message: messageText },
      });
    }
  }
}
