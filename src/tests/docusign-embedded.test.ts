import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createSigningRequest, getEmbeddedSignUrl, sendEmbeddedSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

function setDocuSignEnv(privateKeyPath: string): () => void {
  const previous: Record<string, string | undefined> = {};
  const set = (key: string, value: string) => {
    previous[key] = process.env[key];
    process.env[key] = value;
  };
  set("DOCUSIGN_INTEGRATION_KEY", "ik");
  set("DOCUSIGN_USER_ID", "uid");
  set("DOCUSIGN_ACCOUNT_ID", "acct");
  set("DOCUSIGN_BASE_PATH", "https://demo.docusign.net/restapi");
  set("DOCUSIGN_PRIVATE_KEY_PATH", privateKeyPath);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function writeRsaKey(): string {
  const dir = os.tmpdir();
  const keyPath = path.join(dir, `docusign-test-${Date.now()}-${Math.random()}.pem`);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
  return keyPath;
}

test("DocuSign send-embedded sets clientUserId on signers and getEmbeddedSignUrl posts to /views/recipient", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("docusign-embedded");
  const keyPath = writeRsaKey();
  const restoreEnv = setDocuSignEnv(keyPath);
  const originalFetch = globalThis.fetch;
  try {
    const created = createSigningRequest(db, {
      title: "DocuSign Embedded",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "docusign",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const fetchCalls: Array<{ url: string; method: string; body: string | null }> = [];
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
      const u = String(url);
      if (u.endsWith("/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "tok" }), { status: 200, headers: { "content-type": "application/json" } }) as any;
      }
      if (u.endsWith("/envelopes")) {
        return new Response(JSON.stringify({ envelopeId: "envelope_xx", recipientIds: ["1"] }), { status: 200, headers: { "content-type": "application/json" } }) as any;
      }
      if (u.endsWith("/views/recipient")) {
        return new Response(JSON.stringify({ url: "https://demo.docusign.net/sign?token=abc" }), { status: 200, headers: { "content-type": "application/json" } }) as any;
      }
      return new Response("not found", { status: 404 }) as any;
    }) as any;

    const sent = await sendEmbeddedSigningRequest(db, {
      requestId: created.requestId,
      provider: "docusign",
      apiKey: undefined,
      testMode: false,
    });
    assert.equal(sent.signatureRequestId, "envelope_xx");
    const envelopeBody = JSON.parse(fetchCalls.find((call) => call.url.endsWith("/envelopes"))!.body!);
    const signer = envelopeBody.recipients.signers[0];
    assert.equal(signer.clientUserId, "alice@example.com");

    const signUrl = await getEmbeddedSignUrl(db, {
      requestId: created.requestId,
      provider: "docusign",
      signatureId: "1",
      returnUrl: "https://example.com/return",
    });
    assert.equal(signUrl.signUrl, "https://demo.docusign.net/sign?token=abc");
    const viewCall = fetchCalls.find((call) => call.url.endsWith("/views/recipient"));
    assert.ok(viewCall);
    const viewBody = JSON.parse(viewCall!.body!);
    assert.equal(viewBody.email, "alice@example.com");
    assert.equal(viewBody.clientUserId, "alice@example.com");
    assert.equal(viewBody.returnUrl, "https://example.com/return");

    await assert.rejects(
      () => getEmbeddedSignUrl(db, {
        requestId: created.requestId,
        provider: "docusign",
        signatureId: "1",
      }),
      /requires --return-url/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
    db.close();
    cleanup();
  }
});
