import test from "node:test";
import assert from "node:assert/strict";
import { cancelSigningRequest, createSigningRequest, getRequestSnapshot, sendSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

async function seedSentRequest(db: ReturnType<typeof createDb>, provider: "dropbox" | "signwell" | "docusign", documentPath: string) {
  const created = createSigningRequest(db, {
    title: `${provider} cancel`,
    documentPath,
    signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    tokenTtlMinutes: 30,
    provider,
    autoApprove: true,
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  await sendSigningRequest(db, {
    requestId: created.requestId,
    provider,
    apiKey: "k",
    testMode: true,
    providerSend: async () => ({
      providerRequestId: provider === "docusign" ? "envelope_x" : provider === "signwell" ? "doc_x" : "sigreq_x",
      signatureIds: ["sig_1"],
      providerStatus: "sent",
      responseBody: {},
    }),
  });
  return created.requestId;
}

test("cancelSigningRequest issues provider-specific cancel and persists status", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("cancel-dropbox");
  const originalFetch = globalThis.fetch;
  try {
    const requestId = await seedSentRequest(db, "dropbox", documentPath);
    const fetchCalls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      return { ok: true, status: 200, statusText: "OK", text: async () => "{}" } as any;
    }) as any;

    const result = await cancelSigningRequest(db, { requestId, apiKey: "k" });
    const snapshot = getRequestSnapshot(db, requestId);

    assert.equal(result.provider, "dropbox");
    assert.equal(result.providerRequestId, "sigreq_x");
    assert.equal(result.status, "canceled");
    assert.equal(snapshot.request.status, "canceled");
    assert.equal(snapshot.request.provider_status, "canceled");
    assert.equal(fetchCalls[0].method, "POST");
    assert.match(fetchCalls[0].url, /signature_request\/cancel\/sigreq_x/);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    cleanup();
  }
});

test("cancelSigningRequest issues SignWell DELETE", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("cancel-signwell");
  const originalFetch = globalThis.fetch;
  try {
    const requestId = await seedSentRequest(db, "signwell", documentPath);
    const fetchCalls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      return { ok: true, status: 200, statusText: "OK", text: async () => "{}" } as any;
    }) as any;

    const result = await cancelSigningRequest(db, { requestId, apiKey: "k" });

    assert.equal(result.provider, "signwell");
    assert.equal(result.status, "canceled");
    assert.equal(fetchCalls[0].method, "DELETE");
    assert.match(fetchCalls[0].url, /\/documents\/doc_x$/);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    cleanup();
  }
});

test("cancelSigningRequest requires --reason for DocuSign", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("cancel-docusign");
  try {
    const requestId = await seedSentRequest(db, "docusign", documentPath);
    await assert.rejects(
      () => cancelSigningRequest(db, { requestId }),
      /requires --reason/,
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("cancelSigningRequest rejects unsent requests", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("cancel-unsent");
  try {
    const created = createSigningRequest(db, {
      title: "Unsent",
      documentPath,
      signers: [{ name: "A", email: "a@b.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      now: new Date(),
    });
    await assert.rejects(
      () => cancelSigningRequest(db, { requestId: created.requestId }),
      /has not been sent/,
    );
  } finally {
    db.close();
    cleanup();
  }
});
