import test from "node:test";
import assert from "node:assert/strict";
import { withAuditTamperingAllowed } from "../lib/db.js";
import { appendAuditEvent } from "../lib/audit.js";
import { createSigningRequest, scanAllAuditChains } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("scanAllAuditChains reports valid for a clean DB", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-scan-clean");
  try {
    for (let i = 0; i < 3; i += 1) {
      createSigningRequest(db, {
        title: `Clean ${i}`,
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 60,
        provider: "local",
        autoApprove: true,
      });
    }
    const report = scanAllAuditChains(db);
    assert.equal(report.total, 3);
    assert.equal(report.valid, 3);
    assert.equal(report.invalid, 0);
    for (const r of report.results) assert.equal(r.valid, true);
  } finally {
    db.close();
    cleanup();
  }
});

test("scanAllAuditChains flags requests with tampered chains", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-scan-tamper");
  try {
    const clean = createSigningRequest(db, {
      title: "Clean",
      documentPath,
      signers: [{ name: "A", email: "a@a.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "local",
      autoApprove: true,
    });
    const dirty = createSigningRequest(db, {
      title: "Dirty",
      documentPath,
      signers: [{ name: "B", email: "b@b.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "local",
      autoApprove: true,
    });
    appendAuditEvent(db, { requestId: dirty.requestId, eventType: "evt.x", payload: {} });
    withAuditTamperingAllowed(db, () => {
      db.prepare("UPDATE audit_events SET payload_json = ? WHERE request_id = ?").run("{}", dirty.requestId);
    });

    const report = scanAllAuditChains(db);
    assert.equal(report.total, 2);
    assert.equal(report.valid, 1);
    assert.equal(report.invalid, 1);
    const cleanRow = report.results.find((r) => r.requestId === clean.requestId)!;
    const dirtyRow = report.results.find((r) => r.requestId === dirty.requestId)!;
    assert.equal(cleanRow.valid, true);
    assert.equal(dirtyRow.valid, false);
    assert.match(dirtyRow.break?.kind ?? "", /hash_self_mismatch/);
  } finally {
    db.close();
    cleanup();
  }
});

test("scanAllAuditChains honours --provider and --status filters", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-scan-filter");
  try {
    createSigningRequest(db, {
      title: "Local one",
      documentPath,
      signers: [{ name: "A", email: "a@a.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "local",
      autoApprove: true,
    });
    createSigningRequest(db, {
      title: "Dropbox one",
      documentPath,
      signers: [{ name: "B", email: "b@b.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "dropbox",
      autoApprove: true,
    });
    const localOnly = scanAllAuditChains(db, { provider: "local" });
    assert.equal(localOnly.total, 1);
    assert.equal(localOnly.results[0].title, "Local one");
    const dropboxOnly = scanAllAuditChains(db, { provider: "dropbox" });
    assert.equal(dropboxOnly.total, 1);
    assert.equal(dropboxOnly.results[0].title, "Dropbox one");
  } finally {
    db.close();
    cleanup();
  }
});
