import test from "node:test";
import assert from "node:assert/strict";
import { appendAuditEvent, verifyAuditChain } from "../lib/audit.js";
import { withAuditTamperingAllowed } from "../lib/db.js";
import { createSigningRequest, verifyRequestAuditChain } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("verifyAuditChain returns valid for an untampered chain", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-clean");
  try {
    const created = createSigningRequest(db, {
      title: "Clean chain",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "dropbox",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    appendAuditEvent(db, {
      requestId: created.requestId,
      eventType: "manual.test",
      payload: { hello: "world" },
      now: new Date("2026-01-01T00:00:01.000Z"),
    });

    const result = verifyAuditChain(db, created.requestId);
    assert.equal(result.valid, true);
    assert.equal(result.break, null);
    assert.ok(result.events >= 2);
  } finally {
    db.close();
    cleanup();
  }
});

test("verifyAuditChain detects payload tampering", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-tampered");
  try {
    const created = createSigningRequest(db, {
      title: "Tampered chain",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      now: new Date(),
    });
    withAuditTamperingAllowed(db, () => {
      db.prepare("UPDATE audit_events SET payload_json = ? WHERE request_id = ?").run("{\"hacked\":true}", created.requestId);
    });

    const result = verifyRequestAuditChain(db, created.requestId);
    assert.equal(result.valid, false);
    assert.equal(result.break?.kind, "hash_self_mismatch");
  } finally {
    db.close();
    cleanup();
  }
});

test("verifyAuditChain detects deleted middle event", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-deleted");
  try {
    const created = createSigningRequest(db, {
      title: "Delete chain",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      now: new Date(),
    });
    appendAuditEvent(db, { requestId: created.requestId, eventType: "evt.a", payload: { a: 1 }, now: new Date() });
    appendAuditEvent(db, { requestId: created.requestId, eventType: "evt.b", payload: { b: 2 }, now: new Date() });

    const middle = db.prepare("SELECT id FROM audit_events WHERE request_id = ? ORDER BY id ASC LIMIT 1 OFFSET 1").get(created.requestId) as { id: number };
    withAuditTamperingAllowed(db, () => {
      db.prepare("DELETE FROM audit_events WHERE id = ?").run(middle.id);
    });

    const result = verifyAuditChain(db, created.requestId);
    assert.equal(result.valid, false);
    assert.equal(result.break?.kind, "hash_prev_mismatch");
  } finally {
    db.close();
    cleanup();
  }
});

test("verifyAuditChain reports zero events for unknown requests via lib helper", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = verifyAuditChain(db, "req_nonexistent");
    assert.equal(result.valid, true);
    assert.equal(result.events, 0);
  } finally {
    db.close();
    cleanup();
  }
});
