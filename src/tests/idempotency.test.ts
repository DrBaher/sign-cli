import test from "node:test";
import assert from "node:assert/strict";
import { createSigningRequest, listAuditEvents, sendSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("sendSigningRequest is idempotent: second call returns the original provider id without re-sending", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("idem");
  try {
    const created = createSigningRequest(db, {
      title: "Idempotent",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    let providerCallCount = 0;
    const stubSend = async () => {
      providerCallCount += 1;
      return {
        providerRequestId: `sigreq_${providerCallCount}`,
        signatureIds: [],
        providerStatus: "sent",
        responseBody: { call: providerCallCount },
      };
    };

    const first = await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: "dropbox",
      apiKey: "k",
      testMode: true,
      providerSend: stubSend,
    });
    assert.equal(first.signatureRequestId, "sigreq_1");
    assert.equal(first.idempotent, false);

    const second = await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: "dropbox",
      apiKey: "k",
      testMode: true,
      providerSend: stubSend,
    });
    assert.equal(second.signatureRequestId, "sigreq_1");
    assert.equal(second.idempotent, true);
    assert.equal(providerCallCount, 1);

    const events = listAuditEvents(db, created.requestId).map((evt) => evt.event_type);
    assert.ok(events.includes("request.send_skipped"));
  } finally {
    db.close();
    cleanup();
  }
});

test("sendSigningRequest with --force re-sends past the idempotency guard", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("idem-force");
  try {
    const created = createSigningRequest(db, {
      title: "Force",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    let calls = 0;
    const stubSend = async () => {
      calls += 1;
      return {
        providerRequestId: `sigreq_${calls}`,
        signatureIds: [],
        providerStatus: "sent",
        responseBody: { call: calls },
      };
    };

    await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: "dropbox",
      apiKey: "k",
      testMode: true,
      providerSend: stubSend,
    });
    const second = await sendSigningRequest(db, {
      requestId: created.requestId,
      provider: "dropbox",
      apiKey: "k",
      testMode: true,
      force: true,
      providerSend: stubSend,
    });
    assert.equal(second.signatureRequestId, "sigreq_2");
    assert.equal(calls, 2);
  } finally {
    db.close();
    cleanup();
  }
});
