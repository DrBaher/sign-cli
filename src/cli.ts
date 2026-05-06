#!/usr/bin/env node
import process from "node:process";
import { openDatabase } from "./lib/db.js";
import { requireDropboxApiKey, requireDropboxClientId, resolveDropboxTestMode } from "./lib/dropbox-sign.js";
import { loadEnv } from "./lib/env.js";
import { resolveSignProvider } from "./lib/providers.js";
import {
  approveSigningRequest,
  createSigningRequest,
  getRequestSnapshot,
  fetchFinalSignedPdf,
  getEmbeddedSignUrl,
  getSigningRequestStatus,
  ingestWebhookPayload,
  listAuditEvents,
  REQUEST_WATCH_EXIT_CODES,
  runDoctor,
  runProviderAccountCheck,
  sendEmbeddedSigningRequest,
  sendSigningRequest,
  watchSigningRequestStatus,
} from "./lib/signing-service.js";
import { parseSignerSpec } from "./lib/util.js";
import { loadWebhookPayloadFile, verifyDropboxCallback } from "./lib/webhook.js";
import { startWebhookServer } from "./lib/webhook-server.js";

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

function parseDurationMs(args: ParsedArgs, options: { msFlag: string; secondsFlag: string; defaultMs?: number }): number | undefined {
  const msValue = flagValue(args, options.msFlag);
  if (msValue !== undefined) {
    return Number(msValue);
  }
  const secondsValue = flagValue(args, options.secondsFlag);
  if (secondsValue !== undefined) {
    return Number(secondsValue) * 1000;
  }
  return options.defaultMs;
}

function printUsage(): void {
  console.log(`sign request create --title "Doc" --document ./file.pdf --signer name:Alice,email:alice@example.com,order:1 [--provider dropbox|docusign]
sign request run-email --title "Doc" --document ./file.pdf --signer name:Alice,email:alice@example.com,order:1 [--provider dropbox|docusign] [--test-mode true]
sign approve --request-id <id> --token <token>
sign request send --request-id <id> [--provider dropbox|docusign] [--test-mode true]
sign request send-embedded --request-id <id> --client-id <clientId> [--provider dropbox|docusign] [--test-mode true]
sign request sign-url --request-id <id> --signature-id <signatureId> [--provider dropbox|docusign]
sign request launch-embedded --request-id <id> --signature-id <signatureId> --client-id <clientId> [--provider dropbox|docusign]
sign request fetch-final --request-id <id> [--provider dropbox|docusign] [--out ./artifacts/signed.pdf]
sign request status --request-id <id> [--provider dropbox|docusign]
sign request watch --request-id <id> [--provider dropbox|docusign] [--interval-ms 5000|--interval-seconds 5] [--timeout-ms 600000|--timeout-seconds 600] [--fetch-final true] [--out ./artifacts/signed.pdf]
sign doctor
sign doctor account-check [--provider dropbox|docusign]
sign audit show --request-id <id>
sign webhook verify --payload-file ./fixtures/sample-webhook.json
sign webhook ingest --payload-file ./fixtures/sample-webhook.json [--request-id <id>]
sign webhook listen [--port 3000] [--path /dropbox/callback] [--request-id <id>]`);
}

async function main(): Promise<void> {
  loadEnv();
  const parsed = parseArgs(process.argv.slice(2));
  const dbPath = process.env.SIGN_DB_PATH ?? "./data/sign.db";
  const db = openDatabase(dbPath);
  const selectedProvider = resolveSignProvider(flagValue(parsed, "provider"));

  if (parsed.positionals.length === 0) {
    printUsage();
    return;
  }

  const [root, sub, action] = parsed.positionals;


  if (root === "doctor" && sub === "account-check") {
    const result = await runProviderAccountCheck({
      provider: selectedProvider,
      apiKey: selectedProvider === "dropbox" ? process.env.DROPBOX_SIGN_API_KEY : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "doctor") {
    const apiKey = process.env.DROPBOX_SIGN_API_KEY;
    const result = await runDoctor(apiKey);
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (root === "request" && sub === "run-email") {
    const title = flagValue(parsed, "title", true)!;
    const documentPath = flagValue(parsed, "document", true)!;
    const signers = flagValues(parsed, "signer").map(parseSignerSpec);
    const tokenTtlMinutes = Number(flagValue(parsed, "token-ttl-minutes") ?? "30");
    const created = createSigningRequest(db, {
      title,
      documentPath,
      signers,
      tokenTtlMinutes,
      provider: selectedProvider,
      autoApprove: true,
    });
    const sent = await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: selectedProvider,
      apiKey: selectedProvider === "dropbox" ? requireDropboxApiKey() : undefined,
      testMode: resolveDropboxTestMode(flagValue(parsed, "test-mode")),
    });
    console.log(JSON.stringify({
      mode: "email-only",
      provider: selectedProvider,
      requestId: created.requestId,
      documentHash: created.documentHash,
      approvals: "auto-approved",
      signatureRequestId: sent.signatureRequestId,
    }, null, 2));
    return;
  }

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
      provider: selectedProvider,
      autoApprove: (flagValue(parsed, "auto-approve") ?? "false") === "true",
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
    const result = await sendSigningRequest(db, {
      requestId,
      provider: selectedProvider,
      apiKey: selectedProvider === "dropbox" ? requireDropboxApiKey() : undefined,
      testMode: resolveDropboxTestMode(flagValue(parsed, "test-mode")),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (root === "request" && sub === "send-embedded") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const result = await sendEmbeddedSigningRequest(db, {
      requestId,
      provider: selectedProvider,
      apiKey: selectedProvider === "dropbox" ? requireDropboxApiKey() : undefined,
      clientId: selectedProvider === "dropbox" ? requireDropboxClientId(flagValue(parsed, "client-id")) : undefined,
      testMode: resolveDropboxTestMode(flagValue(parsed, "test-mode")),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "request" && sub === "sign-url") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const signatureId = flagValue(parsed, "signature-id", true)!;
    const result = await getEmbeddedSignUrl(db, {
      requestId,
      provider: selectedProvider,
      signatureId,
      apiKey: selectedProvider === "dropbox" ? requireDropboxApiKey() : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (root === "request" && sub === "launch-embedded") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const signatureId = flagValue(parsed, "signature-id", true)!;
    if (selectedProvider !== "dropbox") {
      throw new Error("Embedded signing is not yet supported for DocuSign.");
    }
    const clientId = requireDropboxClientId(flagValue(parsed, "client-id"));
    const result = await getEmbeddedSignUrl(db, {
      requestId,
      provider: selectedProvider,
      signatureId,
      apiKey: selectedProvider === "dropbox" ? requireDropboxApiKey() : undefined,
    });
    const file = flagValue(parsed, "out") ?? `./embedded-launch-${signatureId}.html`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Embedded Sign</title></head><body><h3>Launching signer...</h3><script src="https://cdn.hellosign.com/public/js/embedded/v2.11.1/embedded.development.js"></script><script>const client=new window.HelloSign();client.open(${JSON.stringify(result.signUrl)},{clientId:${JSON.stringify(clientId)},skipDomainVerification:true});</script></body></html>`;
    const fs = await import("node:fs/promises");
    await fs.writeFile(file, html, "utf8");
    console.log(JSON.stringify({ ...result, launcherFile: file }, null, 2));
    return;
  }

  if (root === "request" && sub === "fetch-final") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const outPath = flagValue(parsed, "out");
    const result = await fetchFinalSignedPdf(db, {
      requestId,
      provider: selectedProvider,
      apiKey: selectedProvider === "dropbox" ? requireDropboxApiKey() : undefined,
      outPath,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "request" && sub === "status") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const result = await getSigningRequestStatus(db, {
      requestId,
      provider: selectedProvider,
      apiKey: selectedProvider === "dropbox" ? requireDropboxApiKey() : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "request" && sub === "watch") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const intervalMs = parseDurationMs(parsed, { msFlag: "interval-ms", secondsFlag: "interval-seconds", defaultMs: 5000 })!;
    const timeoutMs = parseDurationMs(parsed, { msFlag: "timeout-ms", secondsFlag: "timeout-seconds" });
    const fetchFinalPdf = (flagValue(parsed, "fetch-final") ?? "false") === "true";
    const outPath = flagValue(parsed, "out");
    let lastPrintedStatus: string | null = null;
    const result = await watchSigningRequestStatus(db, {
      requestId,
      provider: selectedProvider,
      apiKey: selectedProvider === "dropbox" ? requireDropboxApiKey() : undefined,
      intervalMs,
      timeoutMs,
      fetchFinalPdf,
      outPath,
      onPoll: (update) => {
        const shouldPrint = update.attempt === 1 || update.status !== lastPrintedStatus || update.terminal !== null;
        if (!shouldPrint) {
          return;
        }
        lastPrintedStatus = update.status;
        const elapsedSeconds = (update.elapsedMs / 1000).toFixed(1);
        console.error(
          `[watch] provider=${update.provider} +${elapsedSeconds}s poll=${update.attempt} status=${update.status}${update.terminal ? ` terminal=${update.terminal}` : ""}`,
        );
      },
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.exitCode;
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

  if (root === "webhook" && sub === "listen") {
    const apiKey = requireDropboxApiKey();
    const port = Number(flagValue(parsed, "port") ?? "3000");
    const webhookPath = flagValue(parsed, "path") ?? "/dropbox/callback";
    const requestId = flagValue(parsed, "request-id");
    const server = startWebhookServer({
      dbPath,
      apiKey,
      port,
      path: webhookPath,
      requestId,
    });
    process.on("SIGINT", () => server.close(() => process.exit(0)));
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
    console.log(JSON.stringify({
      listening: true,
      port,
      path: webhookPath,
      requestId: requestId ?? null,
      callbackUrl: `http://127.0.0.1:${port}${webhookPath}`,
      signatureVerification: "event_hash via API key HMAC",
      expectedSuccessExitCode: REQUEST_WATCH_EXIT_CODES.completed,
    }, null, 2));
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
