import test from "node:test";
import assert from "node:assert/strict";
import { bulkSendFromCsv, getRequestSnapshot, listSigningRequests } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("bulkSendFromCsv creates and sends a request per row", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("bulk");
  const originalFetch = globalThis.fetch;
  try {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      return new Response(JSON.stringify({
        signature_request: {
          signature_request_id: `sigreq_${callCount}`,
          signatures: [{ signature_id: `sig_${callCount}` }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }) as any;
    }) as any;

    const result = await bulkSendFromCsv(db, {
      rows: [
        { name: "Alice", email: "alice@example.com" },
        { name: "Bob", email: "bob@example.com" },
      ],
      titleTemplate: "Bulk for {{email}}",
      documentPaths: [documentPath],
      provider: "dropbox",
      apiKey: "k",
      testMode: true,
    });

    assert.equal(result.total, 2);
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 0);
    assert.equal(result.results[0].signerEmail, "alice@example.com");
    assert.equal(result.results[1].signerEmail, "bob@example.com");

    const requests = listSigningRequests(db);
    assert.equal(requests.length, 2);
    const snap = getRequestSnapshot(db, result.results[0].requestId!);
    assert.equal(snap.request.title, "Bulk for alice@example.com");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    cleanup();
  }
});

test("bulkSendFromCsv records row errors instead of throwing", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("bulk-err");
  try {
    const result = await bulkSendFromCsv(db, {
      rows: [
        { name: "", email: "" },
        { name: "Alice", email: "alice@example.com" },
      ],
      titleTemplate: "Bulk",
      documentPaths: [documentPath],
      provider: "dropbox",
      apiKey: "k",
      testMode: true,
      // No fetch stub: the second row will throw too because real fetch fails in sandbox.
    });
    assert.equal(result.total, 2);
    assert.ok(result.failed >= 1);
    assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error ?? "", /missing name and\/or email/);
  } finally {
    db.close();
    cleanup();
  }
});
