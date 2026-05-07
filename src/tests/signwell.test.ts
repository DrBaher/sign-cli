import test from "node:test";
import assert from "node:assert/strict";
import { getRequestSnapshot, sendSigningRequest } from "../lib/signing-service.js";
import {
  normalizeSignWellStatus,
  requireSignWellApiKey,
  resolveSignWellBaseUrl,
} from "../lib/signwell.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";
import { createSigningRequest } from "../lib/signing-service.js";

test("requireSignWellApiKey throws when SIGNWELL_API_KEY is missing", () => {
  const original = process.env.SIGNWELL_API_KEY;
  delete process.env.SIGNWELL_API_KEY;

  try {
    assert.throws(() => requireSignWellApiKey(), /SIGNWELL_API_KEY is not set/);
  } finally {
    if (original === undefined) {
      delete process.env.SIGNWELL_API_KEY;
    } else {
      process.env.SIGNWELL_API_KEY = original;
    }
  }
});

test("resolveSignWellBaseUrl defaults and trims trailing slash", () => {
  assert.equal(resolveSignWellBaseUrl(), "https://www.signwell.com/api/v1");
  assert.equal(resolveSignWellBaseUrl("https://sandbox.signwell.test/api/v1/"), "https://sandbox.signwell.test/api/v1");
});

test("normalizeSignWellStatus lowercases and underscores", () => {
  assert.equal(normalizeSignWellStatus({ status: "In Progress" }), "in_progress");
  assert.equal(normalizeSignWellStatus({ status: "Completed" }), "completed");
});

test("sendSigningRequest persists SignWell metadata", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("signwell persistence");

  try {
    const created = createSigningRequest(db, {
      title: "SignWell Contract",
      documentPath,
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
      tokenTtlMinutes: 60,
      provider: "signwell",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: "signwell",
      apiKey: "signwell-key",
      testMode: true,
      now: new Date("2026-01-01T00:01:00.000Z"),
      providerSend: async () => ({
        providerRequestId: "doc_123",
        signatureIds: ["recipient_1", "recipient_2"],
        providerStatus: "sent",
        responseBody: {
          id: "doc_123",
          status: "Sent",
          recipients: [
            { id: "recipient_1" },
            { id: "recipient_2" },
          ],
        },
      }),
    });
    const snapshot = getRequestSnapshot(db, created.requestId);

    assert.equal(result.provider, "signwell");
    assert.equal(result.signatureRequestId, "doc_123");
    assert.deepEqual(result.signatureIds, ["recipient_1", "recipient_2"]);
    assert.equal(snapshot.request.provider, "signwell");
    assert.equal(snapshot.request.provider_request_id, "doc_123");
    assert.equal(snapshot.request.provider_status, "sent");
    assert.deepEqual(snapshot.request.signatureIds, ["recipient_1", "recipient_2"]);
  } finally {
    db.close();
    cleanup();
  }
});
