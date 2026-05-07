import test from "node:test";
import assert from "node:assert/strict";
import { createSigningRequest, remindSigningRequest, sendSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

async function seedSentDropboxRequest(db: ReturnType<typeof createDb>, documentPath: string): Promise<string> {
  const created = createSigningRequest(db, {
    title: "remind",
    documentPath,
    signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    tokenTtlMinutes: 30,
    provider: "dropbox",
    autoApprove: true,
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  await sendSigningRequest(db, {
    requestId: created.requestId,
    provider: "dropbox",
    apiKey: "k",
    testMode: true,
    providerSend: async () => ({
      providerRequestId: "sigreq_x",
      signatureIds: ["sig_1"],
      providerStatus: "sent",
      responseBody: {},
    }),
  });
  return created.requestId;
}

test("remindSigningRequest hits Dropbox remind endpoint with email", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("remind-dropbox");
  const originalFetch = globalThis.fetch;
  try {
    const requestId = await seedSentDropboxRequest(db, documentPath);
    const fetchCalls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }) as any;
    }) as any;

    const result = await remindSigningRequest(db, { requestId, apiKey: "k", email: "alice@example.com" });
    assert.equal(result.provider, "dropbox");
    assert.equal(result.providerRequestId, "sigreq_x");
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].method, "POST");
    assert.match(fetchCalls[0].url, /signature_request\/remind\/sigreq_x/);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    cleanup();
  }
});

test("remindSigningRequest requires --email for Dropbox", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("remind-dropbox-no-email");
  try {
    const requestId = await seedSentDropboxRequest(db, documentPath);
    await assert.rejects(
      () => remindSigningRequest(db, { requestId, apiKey: "k" }),
      /reminders require --email/i,
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("remindSigningRequest refuses on unsent requests", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("remind-unsent");
  try {
    const created = createSigningRequest(db, {
      title: "unsent",
      documentPath,
      signers: [{ name: "A", email: "a@b.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      now: new Date(),
    });
    await assert.rejects(
      () => remindSigningRequest(db, { requestId: created.requestId, apiKey: "k", email: "a@b.com" }),
      /has not been sent/,
    );
  } finally {
    db.close();
    cleanup();
  }
});
