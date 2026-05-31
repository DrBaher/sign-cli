import test from "node:test";
import assert from "node:assert/strict";
import { appendAuditEvent, verifyAuditChain } from "../lib/audit.js";
import { resetAuditHmacKeyCache } from "../lib/audit-key.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { withAuditTamperingAllowed } from "../lib/db.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

// Helper: run `fn` with the audit HMAC key env set, restoring + clearing the
// resolver cache afterwards so cases don't bleed into each other.
function withKey<T>(key: string | null, fn: () => T): T {
  const prev = process.env.SIGN_AUDIT_HMAC_KEY;
  if (key === null) delete process.env.SIGN_AUDIT_HMAC_KEY;
  else process.env.SIGN_AUDIT_HMAC_KEY = key;
  resetAuditHmacKeyCache();
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SIGN_AUDIT_HMAC_KEY;
    else process.env.SIGN_AUDIT_HMAC_KEY = prev;
    resetAuditHmacKeyCache();
  }
}

function seedRequest(db: ReturnType<typeof createDb>) {
  const documentPath = createDocumentFixture("hmac-chain");
  return createSigningRequest(db, {
    title: "HMAC chain",
    documentPath,
    signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    tokenTtlMinutes: 30,
    provider: "dropbox",
  });
}

test("a keyed chain verifies with the key and stores hash_algo=hmac-sha256", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    withKey("super-secret-key", () => {
      const created = seedRequest(db);
      appendAuditEvent(db, { requestId: created.requestId, eventType: "test.keyed", payload: { n: 1 } });
      const rows = db.prepare("SELECT hash_algo FROM audit_events WHERE request_id = ?").all(created.requestId) as Array<{ hash_algo: string }>;
      assert.ok(rows.length >= 1);
      assert.ok(rows.every((r) => r.hash_algo === "hmac-sha256"), "every event should be keyed");
      assert.equal(verifyAuditChain(db, created.requestId).valid, true);
    });
  } finally {
    db.close();
    cleanup();
  }
});

test("a keyed chain fails verification when the key is absent (fail-closed)", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    let requestId = "";
    withKey("k1", () => {
      const created = seedRequest(db);
      requestId = created.requestId;
      appendAuditEvent(db, { requestId, eventType: "test.keyed", payload: { n: 1 } });
      assert.equal(verifyAuditChain(db, requestId).valid, true);
    });
    // Now with no key configured, the keyed rows must not silently pass.
    withKey(null, () => {
      const res = verifyAuditChain(db, requestId);
      assert.equal(res.valid, false);
      assert.equal(res.break?.kind, "hash_self_mismatch");
    });
  } finally {
    db.close();
    cleanup();
  }
});

test("a keyed chain fails verification under the WRONG key", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    let requestId = "";
    withKey("right-key", () => {
      const created = seedRequest(db);
      requestId = created.requestId;
      appendAuditEvent(db, { requestId, eventType: "test.keyed", payload: { n: 1 } });
    });
    withKey("wrong-key", () => {
      assert.equal(verifyAuditChain(db, requestId).valid, false);
    });
  } finally {
    db.close();
    cleanup();
  }
});

test("unkeyed chains remain byte-identical and keep verifying (backward compatible)", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    withKey(null, () => {
      const created = seedRequest(db);
      appendAuditEvent(db, { requestId: created.requestId, eventType: "test.legacy", payload: { n: 1 } });
      const rows = db.prepare("SELECT hash_algo FROM audit_events WHERE request_id = ?").all(created.requestId) as Array<{ hash_algo: string }>;
      assert.ok(rows.every((r) => r.hash_algo === "sha256"), "events default to the legacy algo");
      assert.equal(verifyAuditChain(db, created.requestId).valid, true);
    });
  } finally {
    db.close();
    cleanup();
  }
});

test("downgrade is rejected: a legacy row appended after a keyed row is flagged as tampering", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    let requestId = "";
    let keyedHead = "";
    withKey("k", () => {
      const created = seedRequest(db);
      requestId = created.requestId;
      const r = appendAuditEvent(db, { requestId, eventType: "test.keyed", payload: { n: 1 } });
      keyedHead = r.hashSelf;
      assert.equal(verifyAuditChain(db, requestId).valid, true);
    });
    // Splice in a forged LEGACY (unkeyed) row that chains off the keyed head.
    // This is what a downgrade attacker would attempt. It must be rejected
    // even though the legacy hash itself is internally consistent.
    withKey(null, () => {
      withAuditTamperingAllowed(db, () => {
        db.prepare(
          "INSERT INTO audit_events (request_id, event_type, payload_json, hash_prev, hash_self, hash_algo, created_at) VALUES (?, ?, ?, ?, ?, 'sha256', ?)",
        ).run(requestId, "test.forged", "{}", keyedHead, "deadbeef", "2026-05-08T12:00:00.000Z");
      });
    });
    withKey("k", () => {
      const res = verifyAuditChain(db, requestId);
      assert.equal(res.valid, false, "a legacy row after a keyed row must fail");
    });
  } finally {
    db.close();
    cleanup();
  }
});
