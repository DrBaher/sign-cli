#!/usr/bin/env node
import process from "node:process";
import { openDatabase } from "./lib/db.js";
import { requireDropboxApiKey, resolveDropboxTestMode } from "./lib/dropbox-sign.js";
import { loadEnv } from "./lib/env.js";
import {
  approveSigningRequest,
  createSigningRequest,
  getRequestSnapshot,
  getSigningRequestStatus,
  ingestWebhookPayload,
  listAuditEvents,
  sendSigningRequest,
} from "./lib/signing-service.js";
import { parseSignerSpec } from "./lib/util.js";
import { loadWebhookPayloadFile, verifyDropboxCallback } from "./lib/webhook.js";

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string[]>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith("--")) {
      positionals.push(part);
      continue;
    }
    const key = part.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, [...(flags.get(key) ?? []), "true"]);
      continue;
    }
    flags.set(key, [...(flags.get(key) ?? []), next]);
    index += 1;
  }

  return { positionals, flags };
}

function flagValue(args: ParsedArgs, name: string, required = false): string | undefined {
  const values = args.flags.get(name);
  if ((!values || values.length === 0) && required) {
    throw new Error(`Missing required flag: --${name}`);
  }
  return values?.at(-1);
}

function flagValues(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

function printUsage(): void {
  console.log(`sign request create --title "Doc" --document ./file.pdf --signer name:Alice,email:alice@example.com,order:1
sign approve --request-id <id> --token <token>
sign request send --request-id <id> [--test-mode true]
sign request status --request-id <id>
sign audit show --request-id <id>
sign webhook verify --payload-file ./fixtures/sample-webhook.json
sign webhook ingest --payload-file ./fixtures/sample-webhook.json [--request-id <id>]`);
}

async function main(): Promise<void> {
  loadEnv();
  const parsed = parseArgs(process.argv.slice(2));
  const dbPath = process.env.SIGN_DB_PATH ?? "./data/sign.db";
  const db = openDatabase(dbPath);

  if (parsed.positionals.length === 0) {
    printUsage();
    return;
  }

  const [root, sub, action] = parsed.positionals;

  if (root === "request" && sub === "create") {
    const title = flagValue(parsed, "title", true)!;
    const documentPath = flagValue(parsed, "document", true)!;
    const signers = flagValues(parsed, "signer").map(parseSignerSpec);
    const tokenTtlMinutes = Number(flagValue(parsed, "token-ttl-minutes") ?? "60");
    const result = createSigningRequest(db, {
      title,
      documentPath,
      signers,
      tokenTtlMinutes,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "approve") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const token = flagValue(parsed, "token", true)!;
    const result = approveSigningRequest(db, { requestId, token });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "request" && sub === "send") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const apiKey = requireDropboxApiKey();
    const result = await sendSigningRequest(db, {
      requestId,
      apiKey,
      testMode: resolveDropboxTestMode(flagValue(parsed, "test-mode")),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "request" && sub === "status") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const apiKey = requireDropboxApiKey();
    const result = await getSigningRequestStatus(db, { requestId, apiKey });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "audit" && sub === "show") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const events = listAuditEvents(db, requestId);
    console.log(JSON.stringify(events, null, 2));
    return;
  }

  if (root === "webhook" && sub === "verify") {
    const payloadFile = flagValue(parsed, "payload-file", true)!;
    const apiKey = requireDropboxApiKey();
    const payload = await loadWebhookPayloadFile(payloadFile);
    const verified = verifyDropboxCallback(apiKey, payload);
    console.log(JSON.stringify({ verified, event: payload.event ?? null }, null, 2));
    return;
  }

  if (root === "webhook" && sub === "ingest") {
    const payloadFile = flagValue(parsed, "payload-file", true)!;
    const apiKey = requireDropboxApiKey();
    const payload = await loadWebhookPayloadFile(payloadFile);
    const result = ingestWebhookPayload(db, {
      payload,
      apiKey,
      requestId: flagValue(parsed, "request-id"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "request" && sub === "show") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const snapshot = getRequestSnapshot(db, requestId);
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  printUsage();
  throw new Error(`Unknown command: ${parsed.positionals.join(" ")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
