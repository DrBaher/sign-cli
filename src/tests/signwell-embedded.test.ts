import test from "node:test";
import assert from "node:assert/strict";
import { extractSignWellEmbeddedSignUrl } from "../lib/signwell.js";
import {
  getEmbeddedSignUrl,
  getRequestSnapshot,
  sendEmbeddedSigningRequest,
  createSigningRequest,
} from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("extractSignWellEmbeddedSignUrl pulls per-recipient embedded URL", () => {
  const document = {
    id: "doc_x",
    recipients: [
      { id: "r1", embedded_signing_url: "https://signwell.com/sign/abc" },
      { id: "r2", signing_url: "https://signwell.com/sign/xyz" },
      { id: "r3" },
    ],
  };
  assert.deepEqual(extractSignWellEmbeddedSignUrl(document, "r1"), { signUrl: "https://signwell.com/sign/abc", expiresAt: null });
  assert.deepEqual(extractSignWellEmbeddedSignUrl(document, "r2"), { signUrl: "https://signwell.com/sign/xyz", expiresAt: null });
  assert.equal(extractSignWellEmbeddedSignUrl(document, "r3"), null);
  assert.equal(extractSignWellEmbeddedSignUrl(null, "r1"), null);
});

test("sendEmbeddedSigningRequest routes through SignWell embedded provider api", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("sw-embedded");
  const originalFetch = globalThis.fetch;

  try {
    const created = createSigningRequest(db, {
      title: "SignWell Embedded",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "signwell",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const fetchCalls: Array<{ url: string; init: any }> = [];
    globalThis.fetch = (async (url: string, init?: any) => {
      fetchCalls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({
          id: "doc_embedded",
          status: "Sent",
          recipients: [
            { id: "recipient_1", embedded_signing_url: "https://www.signwell.com/sign/abc" },
          ],
        }),
      } as any;
    }) as any;

    const sent = await sendEmbeddedSigningRequest(db, {
      requestId: created.requestId,
      provider: "signwell",
      apiKey: "test-key",
      testMode: true,
    });

    assert.equal(fetchCalls.length, 1);
    const sentBody = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sentBody.embedded_signing, true);

    assert.equal(sent.provider, "signwell");
    assert.equal(sent.signatureRequestId, "doc_embedded");
    assert.deepEqual(sent.signatureIds, ["recipient_1"]);

    const snapshot = getRequestSnapshot(db, created.requestId);
    assert.equal(snapshot.request.provider_request_id, "doc_embedded");

    fetchCalls.length = 0;
    globalThis.fetch = (async (url: string) => {
      fetchCalls.push({ url: String(url), init: null });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify({
          id: "doc_embedded",
          recipients: [
            { id: "recipient_1", embedded_signing_url: "https://www.signwell.com/sign/abc" },
          ],
        }),
      } as any;
    }) as any;

    const url = await getEmbeddedSignUrl(db, {
      requestId: created.requestId,
      provider: "signwell",
      signatureId: "recipient_1",
      apiKey: "test-key",
    });

    assert.equal(url.signUrl, "https://www.signwell.com/sign/abc");
    assert.equal(url.signatureId, "recipient_1");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
    cleanup();
  }
});
