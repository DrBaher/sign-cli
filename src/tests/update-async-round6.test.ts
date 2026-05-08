import test from "node:test";
import assert from "node:assert/strict";
import {
  createSigningRequest,
  markApprovalUsedAsync,
  updateRequestStatusAsync,
} from "../lib/signing-service.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("updateRequestStatusAsync flips status + updated_at on the SqliteBackend", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("status-async");
  try {
    const created = createSigningRequest(db, {
      title: "Status async",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const backend = wrapSqliteDb(db);
    await updateRequestStatusAsync(backend, created.requestId, "completed", new Date("2026-05-08T12:00:00Z"));
    const row = db.prepare("SELECT status, updated_at FROM requests WHERE id = ?")
      .get(created.requestId) as { status: string; updated_at: string };
    assert.equal(row.status, "completed");
    assert.equal(row.updated_at, "2026-05-08T12:00:00.000Z");
  } finally {
    db.close();
    cleanup();
  }
});

test("updateRequestStatusAsync against PostgresBackend uses translated $N placeholders", async () => {
  const seen: Array<{ text: string; params?: unknown[] }> = [];
  const fakeClient: PgQueryable = {
    async query(text, params) {
      seen.push({ text, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const backend = new PostgresBackend(fakeClient);
  await updateRequestStatusAsync(backend, "req-1", "sent", new Date("2026-05-08T00:00:00Z"));
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /SET status = \$1/);
  assert.match(seen[0].text, /WHERE id = \$3/);
  assert.deepEqual(seen[0].params, ["sent", "2026-05-08T00:00:00.000Z", "req-1"]);
});

test("markApprovalUsedAsync writes used_at + approved_at to the same nowStamp", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("approval-async");
  try {
    const created = createSigningRequest(db, {
      title: "Approval async",
      documentPath,
      signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const approval = db.prepare("SELECT id FROM approvals WHERE request_id = ? LIMIT 1")
      .get(created.requestId) as { id: string };
    const backend = wrapSqliteDb(db);
    const nowStamp = "2026-05-08T13:00:00.000Z";
    await markApprovalUsedAsync(backend, approval.id, nowStamp);
    const row = db.prepare("SELECT used_at, approved_at FROM approvals WHERE id = ?")
      .get(approval.id) as { used_at: string; approved_at: string };
    assert.equal(row.used_at, nowStamp);
    assert.equal(row.approved_at, nowStamp);
  } finally {
    db.close();
    cleanup();
  }
});
