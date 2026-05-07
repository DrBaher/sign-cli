#!/usr/bin/env node
import process from "node:process";
import { openDatabase } from "./lib/db.js";
import { requireDropboxApiKey, requireDropboxClientId, resolveDropboxTestMode } from "./lib/dropbox-sign.js";
import { loadEnv } from "./lib/env.js";
import { loadCsvFile } from "./lib/csv.js";
import { collectInitAnswers, createDefaultIo, writeEnvFile } from "./lib/init-wizard.js";
import { createLogger, resolveLogMode } from "./lib/logger.js";
import { resolveSignProvider, type SignProvider } from "./lib/providers.js";
import { requireSignWellApiKey, resolveSignWellTestMode } from "./lib/signwell.js";
import { loadSignWellWebhookPayloadFile, requireSignWellWebhookSecret, verifySignWellCallback } from "./lib/signwell-webhook.js";
import {
  approveSigningRequest,
  buildProviderMatrix,
  bulkSendFromCsv,
  cancelSigningRequest,
  createSigningRequest,
  exportAuditBundle,
  getRequestSnapshot,
  fetchFinalSignedPdf,
  getEmbeddedSignUrl,
  getSigningRequestStatus,
  ingestSignWellWebhookPayload,
  ingestWebhookPayload,
  inspectRequestSignedPdf,
  listAuditEvents,
  listSigningRequests,
  REQUEST_WATCH_EXIT_CODES,
  remindSigningRequest,
  runDoctor,
  runProviderAccountCheck,
  runSignWellSmokeTest,
  sendEmbeddedSigningRequest,
  sendSigningRequest,
  timestampRequestAuditChain,
  verifyRequestAuditChain,
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
  console.log(`sign request create --title "Doc" --document ./file.pdf [--document ./extra.pdf] --signer name:Alice,email:alice@example.com,order:1 [--provider dropbox|docusign|signwell]
sign request run-email --title "Doc" --document ./file.pdf [--document ./extra.pdf] --signer name:Alice,email:alice@example.com,order:1 [--provider dropbox|docusign|signwell] [--test-mode true]
sign approve --request-id <id> --token <token>
sign request send --request-id <id> [--provider dropbox|docusign|signwell] [--test-mode true]
sign request send-embedded --request-id <id> [--client-id <clientId>] [--provider dropbox|docusign|signwell] [--test-mode true]
sign request sign-url --request-id <id> --signature-id <signatureId> [--provider dropbox|docusign|signwell] [--return-url https://...]
sign request launch-embedded --request-id <id> --signature-id <signatureId> [--client-id <clientId>] [--provider dropbox|docusign|signwell] [--return-url https://...]
sign request fetch-final --request-id <id> [--provider dropbox|docusign|signwell] [--out ./artifacts/signed.pdf]
sign request status --request-id <id> [--provider dropbox|docusign|signwell]
sign request watch --request-id <id> [--provider dropbox|docusign|signwell] [--interval-ms 5000|--interval-seconds 5] [--timeout-ms 600000|--timeout-seconds 600] [--fetch-final true] [--out ./artifacts/signed.pdf] [--log human|json]
sign request remind --request-id <id> [--provider dropbox|docusign|signwell] [--email signer@example.com]
sign request cancel --request-id <id> [--provider dropbox|docusign|signwell] [--reason "Voided"] [--yes]
sign request bulk --csv ./signers.csv --document ./file.pdf [--document ./extra.pdf] [--provider dropbox|docusign|signwell] [--title "Bulk for {{email}}"] [--test-mode true]
sign request list [--provider dropbox|docusign|signwell] [--status created|sent|approved|completed|canceled] [--limit 100]
sign request show --request-id <id>
sign smoke signwell --document ./file.pdf [--signer-name Name] [--signer-email a@b] [--interval-seconds 5] [--timeout-seconds 60] [--fetch-final true] [--out ./artifacts/signed.pdf]
sign init [--out ./.env]
sign doctor
sign doctor account-check [--provider dropbox|docusign|signwell]
sign doctor providers
sign audit show --request-id <id>
sign audit verify --request-id <id>
sign audit timestamp --request-id <id> [--tsa-url http://timestamp.digicert.com]
sign audit export --request-id <id> --out ./bundle/
sign request verify-signed-pdf --request-id <id> [--path ./signed.pdf]
sign webhook verify [--provider dropbox|signwell] --payload-file ./fixtures/sample-webhook.json
sign webhook ingest [--provider dropbox|signwell] --payload-file ./fixtures/sample-webhook.json [--request-id <id>]
sign webhook listen [--provider dropbox|signwell] [--port 3000] [--path /dropbox/callback] [--request-id <id>]`);
}

function resolveProviderApiKey(provider: ReturnType<typeof resolveSignProvider>): string | undefined {
  if (provider === "dropbox") {
    return requireDropboxApiKey();
  }
  if (provider === "signwell") {
    return requireSignWellApiKey();
  }
  return undefined;
}

function resolveWebhookProvider(provider: SignProvider): "dropbox" | "signwell" {
  if (provider === "signwell") {
    return "signwell";
  }
  if (provider === "docusign") {
    throw new Error("Webhook commands support --provider dropbox or signwell only.");
  }
  return "dropbox";
}

function resolveProviderTestMode(provider: ReturnType<typeof resolveSignProvider>, flag?: string): boolean {
  if (provider === "dropbox") {
    return resolveDropboxTestMode(flag);
  }
  if (provider === "signwell") {
    return resolveSignWellTestMode(flag);
  }
  return false;
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


  if (root === "doctor" && sub === "providers") {
    console.log(JSON.stringify(buildProviderMatrix(), null, 2));
    return;
  }

  if (root === "init") {
    const { io, close } = createDefaultIo();
    try {
      const answers = await collectInitAnswers(io);
      const result = writeEnvFile(answers, { path: flagValue(parsed, "out") });
      console.log(JSON.stringify({ provider: answers.provider, ...result }, null, 2));
    } finally {
      close();
    }
    return;
  }

  if (root === "smoke" && sub === "signwell") {
    const documentPath = flagValue(parsed, "document", true)!;
    const apiKey = requireSignWellApiKey();
    const signerName = flagValue(parsed, "signer-name");
    const signerEmail = flagValue(parsed, "signer-email");
    const intervalMs = parseDurationMs(parsed, { msFlag: "interval-ms", secondsFlag: "interval-seconds", defaultMs: 5000 })!;
    const timeoutMs = parseDurationMs(parsed, { msFlag: "timeout-ms", secondsFlag: "timeout-seconds", defaultMs: 60_000 })!;
    const fetchFinalPdf = (flagValue(parsed, "fetch-final") ?? "false") === "true";
    const outPath = flagValue(parsed, "out");
    const result = await runSignWellSmokeTest(db, {
      apiKey,
      documentPath,
      title: flagValue(parsed, "title"),
      signerName,
      signerEmail,
      intervalMs,
      timeoutMs,
      fetchFinalPdf,
      outPath,
      onProgress: (line) => console.error(line),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "doctor" && sub === "account-check") {
    const result = await runProviderAccountCheck({
      provider: selectedProvider,
      apiKey: selectedProvider === "dropbox"
        ? process.env.DROPBOX_SIGN_API_KEY
        : selectedProvider === "signwell"
          ? process.env.SIGNWELL_API_KEY
          : undefined,
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
    const documentPaths = flagValues(parsed, "document");
    if (documentPaths.length === 0) {
      throw new Error("Missing required flag: --document");
    }
    const signers = flagValues(parsed, "signer").map(parseSignerSpec);
    const tokenTtlMinutes = Number(flagValue(parsed, "token-ttl-minutes") ?? "30");
    const created = createSigningRequest(db, {
      title,
      documentPaths,
      signers,
      tokenTtlMinutes,
      provider: selectedProvider,
      autoApprove: true,
    });
    const sent = await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: selectedProvider,
      apiKey: resolveProviderApiKey(selectedProvider),
      testMode: resolveProviderTestMode(selectedProvider, flagValue(parsed, "test-mode")),
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
    const documentPaths = flagValues(parsed, "document");
    if (documentPaths.length === 0) {
      throw new Error("Missing required flag: --document");
    }
    const signers = flagValues(parsed, "signer").map(parseSignerSpec);
    const tokenTtlMinutes = Number(flagValue(parsed, "token-ttl-minutes") ?? "60");
    const result = createSigningRequest(db, {
      title,
      documentPaths,
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
      apiKey: resolveProviderApiKey(selectedProvider),
      testMode: resolveProviderTestMode(selectedProvider, flagValue(parsed, "test-mode")),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (root === "request" && sub === "send-embedded") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const result = await sendEmbeddedSigningRequest(db, {
      requestId,
      provider: selectedProvider,
      apiKey: resolveProviderApiKey(selectedProvider),
      clientId: selectedProvider === "dropbox" ? requireDropboxClientId(flagValue(parsed, "client-id")) : undefined,
      testMode: resolveProviderTestMode(selectedProvider, flagValue(parsed, "test-mode")),
    });
    if (selectedProvider === "signwell") {
      const document = (result.responseBody as any) ?? {};
      const recipients = Array.isArray(document?.recipients)
        ? document.recipients.map((recipient: any) => ({
          id: recipient?.id,
          email: recipient?.email,
          embeddedSigningUrl: recipient?.embedded_signing_url ?? null,
        }))
        : [];
      console.log(JSON.stringify({ ...result, signwell: { documentId: result.signatureRequestId, recipients } }, null, 2));
      return;
    }
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
      apiKey: resolveProviderApiKey(selectedProvider),
      returnUrl: flagValue(parsed, "return-url"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }


  if (root === "request" && sub === "launch-embedded") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const signatureId = flagValue(parsed, "signature-id", true)!;
    const result = await getEmbeddedSignUrl(db, {
      requestId,
      provider: selectedProvider,
      signatureId,
      apiKey: resolveProviderApiKey(selectedProvider),
      returnUrl: flagValue(parsed, "return-url"),
    });
    const file = flagValue(parsed, "out") ?? `./embedded-launch-${signatureId}.html`;
    const fs = await import("node:fs/promises");
    if (selectedProvider === "signwell" || selectedProvider === "docusign") {
      const title = selectedProvider === "docusign" ? "DocuSign Embedded Sign" : "SignWell Embedded Sign";
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;}</style></head><body><iframe src=${JSON.stringify(result.signUrl)} allow="camera *; microphone *" allowfullscreen></iframe></body></html>`;
      await fs.writeFile(file, html, "utf8");
      console.log(JSON.stringify({ ...result, launcherFile: file, mode: "iframe" }, null, 2));
      return;
    }
    const clientId = requireDropboxClientId(flagValue(parsed, "client-id"));
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Embedded Sign</title></head><body><h3>Launching signer...</h3><script src="https://cdn.hellosign.com/public/js/embedded/v2.11.1/embedded.development.js"></script><script>const client=new window.HelloSign();client.open(${JSON.stringify(result.signUrl)},{clientId:${JSON.stringify(clientId)},skipDomainVerification:true});</script></body></html>`;
    await fs.writeFile(file, html, "utf8");
    console.log(JSON.stringify({ ...result, launcherFile: file, mode: "hellosign-embedded-js" }, null, 2));
    return;
  }

  if (root === "request" && sub === "fetch-final") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const outPath = flagValue(parsed, "out");
    const result = await fetchFinalSignedPdf(db, {
      requestId,
      provider: selectedProvider,
      apiKey: resolveProviderApiKey(selectedProvider),
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
      apiKey: resolveProviderApiKey(selectedProvider),
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
    const logger = createLogger({ mode: resolveLogMode(flagValue(parsed, "log")) });
    let lastPrintedStatus: string | null = null;
    const result = await watchSigningRequestStatus(db, {
      requestId,
      provider: selectedProvider,
      apiKey: resolveProviderApiKey(selectedProvider),
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
        logger.info("watch poll", {
          provider: update.provider,
          attempt: update.attempt,
          status: update.status,
          terminal: update.terminal,
          elapsedSeconds: Number((update.elapsedMs / 1000).toFixed(1)),
        });
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

  if (root === "audit" && sub === "verify") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const result = verifyRequestAuditChain(db, requestId);
    console.log(JSON.stringify({ requestId, ...result }, null, 2));
    process.exitCode = result.valid ? 0 : 3;
    return;
  }

  if (root === "audit" && sub === "timestamp") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const result = await timestampRequestAuditChain(db, {
      requestId,
      tsaUrl: flagValue(parsed, "tsa-url"),
      outPath: flagValue(parsed, "out"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "audit" && sub === "export") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const out = flagValue(parsed, "out", true)!;
    const result = await exportAuditBundle(db, { requestId, outDir: out });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "request" && sub === "verify-signed-pdf") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const result = await inspectRequestSignedPdf(db, { requestId, path: flagValue(parsed, "path") });
    console.log(JSON.stringify(result, null, 2));
    const allDigestsValid = result.report.signatures.length > 0
      && result.report.signatures.every((sig) => sig.messageDigestMatches === true);
    process.exitCode = allDigestsValid ? 0 : 3;
    return;
  }

  if (root === "request" && sub === "list") {
    const provider = flagValue(parsed, "provider") ? selectedProvider : undefined;
    const status = flagValue(parsed, "status");
    const limit = flagValue(parsed, "limit") ? Number(flagValue(parsed, "limit")) : undefined;
    const rows = listSigningRequests(db, { provider, status, limit });
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (root === "request" && sub === "remind") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const email = flagValue(parsed, "email");
    const result = await remindSigningRequest(db, {
      requestId,
      provider: selectedProvider,
      apiKey: resolveProviderApiKey(selectedProvider),
      email,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "request" && sub === "bulk") {
    const csvPath = flagValue(parsed, "csv", true)!;
    const documentPaths = flagValues(parsed, "document");
    if (documentPaths.length === 0) {
      throw new Error("Missing required flag: --document");
    }
    const titleTemplate = flagValue(parsed, "title") ?? "Bulk send for {{email}}";
    const tokenTtlMinutes = flagValue(parsed, "token-ttl-minutes") ? Number(flagValue(parsed, "token-ttl-minutes")) : undefined;
    const rows = await loadCsvFile(csvPath);
    const logger = createLogger({ mode: resolveLogMode(flagValue(parsed, "log")) });
    const result = await bulkSendFromCsv(db, {
      rows,
      titleTemplate,
      documentPaths,
      provider: selectedProvider,
      apiKey: resolveProviderApiKey(selectedProvider),
      testMode: resolveProviderTestMode(selectedProvider, flagValue(parsed, "test-mode")),
      tokenTtlMinutes,
      onProgress: (event) => {
        logger.info("bulk", event);
      },
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.failed > 0) process.exitCode = 3;
    return;
  }

  if (root === "request" && sub === "cancel") {
    const requestId = flagValue(parsed, "request-id", true)!;
    const reason = flagValue(parsed, "reason");
    const confirmed = (flagValue(parsed, "yes") ?? "false") === "true";
    if (!confirmed) {
      throw new Error("request cancel is destructive at the provider. Re-run with --yes true to confirm.");
    }
    const result = await cancelSigningRequest(db, {
      requestId,
      provider: selectedProvider,
      apiKey: resolveProviderApiKey(selectedProvider),
      reason,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (root === "webhook" && sub === "verify") {
    const webhookProvider = resolveWebhookProvider(selectedProvider);
    const payloadFile = flagValue(parsed, "payload-file", true)!;
    if (webhookProvider === "signwell") {
      const secret = requireSignWellWebhookSecret();
      const payload = await loadSignWellWebhookPayloadFile(payloadFile);
      const verified = verifySignWellCallback(secret, payload, null);
      console.log(JSON.stringify({ provider: "signwell", verified, event: payload.event ?? null }, null, 2));
      return;
    }
    const apiKey = requireDropboxApiKey();
    const payload = await loadWebhookPayloadFile(payloadFile);
    const verified = verifyDropboxCallback(apiKey, payload);
    console.log(JSON.stringify({ provider: "dropbox", verified, event: payload.event ?? null }, null, 2));
    return;
  }

  if (root === "webhook" && sub === "ingest") {
    const webhookProvider = resolveWebhookProvider(selectedProvider);
    const payloadFile = flagValue(parsed, "payload-file", true)!;
    if (webhookProvider === "signwell") {
      const secret = requireSignWellWebhookSecret();
      const payload = await loadSignWellWebhookPayloadFile(payloadFile);
      const result = ingestSignWellWebhookPayload(db, {
        payload,
        secret,
        requestId: flagValue(parsed, "request-id"),
      });
      console.log(JSON.stringify({ provider: "signwell", ...result }, null, 2));
      return;
    }
    const apiKey = requireDropboxApiKey();
    const payload = await loadWebhookPayloadFile(payloadFile);
    const result = ingestWebhookPayload(db, {
      payload,
      apiKey,
      requestId: flagValue(parsed, "request-id"),
    });
    console.log(JSON.stringify({ provider: "dropbox", ...result }, null, 2));
    return;
  }

  if (root === "webhook" && sub === "listen") {
    const webhookProvider = resolveWebhookProvider(selectedProvider);
    const apiKey = webhookProvider === "signwell"
      ? requireSignWellWebhookSecret()
      : requireDropboxApiKey();
    const port = Number(flagValue(parsed, "port") ?? "3000");
    const defaultPath = webhookProvider === "signwell" ? "/signwell/callback" : "/dropbox/callback";
    const webhookPath = flagValue(parsed, "path") ?? defaultPath;
    const requestId = flagValue(parsed, "request-id");
    const server = startWebhookServer({
      dbPath,
      apiKey,
      port,
      path: webhookPath,
      requestId,
      provider: webhookProvider,
    });
    process.on("SIGINT", () => server.close(() => process.exit(0)));
    process.on("SIGTERM", () => server.close(() => process.exit(0)));
    console.log(JSON.stringify({
      listening: true,
      provider: webhookProvider,
      port,
      path: webhookPath,
      requestId: requestId ?? null,
      callbackUrl: `http://127.0.0.1:${port}${webhookPath}`,
      signatureVerification: webhookProvider === "signwell"
        ? "event.hash via SIGNWELL_WEBHOOK_SECRET HMAC (or X-SignWell-Webhook-Signature header)"
        : "event_hash via API key HMAC",
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
