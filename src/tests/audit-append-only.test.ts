import test from "node:test";
import assert from "node:assert/strict";
import {
  dropAuditAppendOnlyTriggers,
  installAuditAppendOnlyTriggers,
  withAuditTamperingAllowed,
} from "../lib/db.js";
import { appendAuditEvent } from "../lib/audit.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("audit_events UPDATE is rejected by the append-only trigger", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-trigger-update");
  try {
    const created = createSigningRequest(db, {
      title: "Trigger update",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
    });
    assert.throws(
      () => db.prepare("UPDATE audit_events SET payload_json = ? WHERE request_id = ?").run("{}", created.requestId),
      /append-only.*UPDATE not permitted/i,
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("audit_events DELETE is rejected by the append-only trigger", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-trigger-delete");
  try {
    const created = createSigningRequest(db, {
      title: "Trigger delete",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
    });
    appendAuditEvent(db, { requestId: created.requestId, eventType: "evt.x", payload: { x: 1 } });
    assert.throws(
      () => db.prepare("DELETE FROM audit_events WHERE request_id = ?").run(created.requestId),
      /append-only.*DELETE not permitted/i,
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("INSERT into audit_events still works (and remains the only mutation that does)", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-trigger-insert");
  try {
    const created = createSigningRequest(db, {
      title: "Trigger insert",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
    });
    const before = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE request_id = ?").get(created.requestId) as { n: number };
    appendAuditEvent(db, { requestId: created.requestId, eventType: "evt.x", payload: { x: 1 } });
    const after = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE request_id = ?").get(created.requestId) as { n: number };
    assert.equal(after.n, before.n + 1);
  } finally {
    db.close();
    cleanup();
  }
});

test("withAuditTamperingAllowed temporarily lifts the guard, then re-installs it", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-trigger-tamper-allowed");
  try {
    const created = createSigningRequest(db, {
      title: "Allowed tamper",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
    });
    // Inside the helper: tamper succeeds.
    withAuditTamperingAllowed(db, () => {
      db.prepare("UPDATE audit_events SET payload_json = ? WHERE request_id = ?").run("{\"hacked\":true}", created.requestId);
    });
    // After the helper: the guard is back.
    assert.throws(
      () => db.prepare("DELETE FROM audit_events WHERE request_id = ?").run(created.requestId),
      /append-only/i,
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("dropAuditAppendOnlyTriggers + installAuditAppendOnlyTriggers are idempotent", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    // Calling install twice on a fresh DB shouldn't throw.
    installAuditAppendOnlyTriggers(db);
    installAuditAppendOnlyTriggers(db);
    // Drop, then drop again — IF EXISTS makes both safe.
    dropAuditAppendOnlyTriggers(db);
    dropAuditAppendOnlyTriggers(db);
    // Re-install and confirm the guard is back.
    installAuditAppendOnlyTriggers(db);
    db.prepare(
      "INSERT INTO requests (id, title, document_path, document_hash, status, signers_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("req_idemp", "x", "/tmp/x.pdf", "h", "sent", "[]", "2026-01-01", "2026-01-01");
    appendAuditEvent(db, { requestId: "req_idemp", eventType: "evt.x", payload: {} });
    assert.throws(
      () => db.prepare("DELETE FROM audit_events WHERE request_id = ?").run("req_idemp"),
      /append-only/i,
    );
  } finally {
    db.close();
    cleanup();
  }
});
