import test from "node:test";
import assert from "node:assert/strict";
import {
  createSigningRequest,
  insertArtifactRowAsync,
  markAllRequestApprovalsUsedAsync,
} from "../lib/signing-service.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("insertArtifactRowAsync persists a new artifact row that subsequent SELECTs find (SqliteBackend)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("artifact-async");
  try {
    const r = createSigningRequest(db, {
      title: "Artifact",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const backend = wrapSqliteDb(db);
    await insertArtifactRowAsync(backend, {
      id: "art-async-test",
      requestId: r.requestId,
      kind: "audit_anchor",
      path: "/tmp/anchor.tsr",
      contentHash: "ff".repeat(32),
      metadataJson: '{"tsaUrl":"http://x"}',
      createdAt: "2026-05-08T12:00:00Z",
    });
    const row = db.prepare("SELECT kind, path, content_hash FROM artifacts WHERE id = ?")
      .get("art-async-test") as { kind: string; path: string; content_hash: string };
    assert.equal(row.kind, "audit_anchor");
    assert.equal(row.path, "/tmp/anchor.tsr");
    assert.equal(row.content_hash, "ff".repeat(32));
  } finally {
    db.close();
    cleanup();
  }
});

test("insertArtifactRowAsync against PostgresBackend uses translated $1..$7 placeholders + 7 params", async () => {
  const seen: Array<{ text: string; params?: unknown[] }> = [];
  const fakeClient: PgQueryable = {
    async query(text, params) {
      seen.push({ text, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const backend = new PostgresBackend(fakeClient);
  await insertArtifactRowAsync(backend, {
    id: "art-1", requestId: "req-1", kind: "signed_pdf", path: "/x/y.pdf",
    contentHash: "0".repeat(64), metadataJson: "{}", createdAt: "2026-05-08T12:00:00Z",
  });
  assert.equal(seen.length, 1);
  for (let i = 1; i <= 7; i += 1) assert.ok(seen[0].text.includes(`$${i}`));
  assert.ok(!seen[0].text.includes("?"));
  assert.equal(seen[0].params?.length, 7);
});

test("markAllRequestApprovalsUsedAsync writes used_at + approved_at across every approval for a request", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("bulk-approval-async");
  try {
    const r = createSigningRequest(db, {
      title: "Bulk approval",
      documentPath,
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const backend = wrapSqliteDb(db);
    const nowStamp = "2026-05-08T13:00:00.000Z";
    await markAllRequestApprovalsUsedAsync(backend, r.requestId, nowStamp);
    const rows = db.prepare("SELECT used_at, approved_at FROM approvals WHERE request_id = ?")
      .all(r.requestId) as Array<{ used_at: string; approved_at: string }>;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.used_at, nowStamp);
      assert.equal(row.approved_at, nowStamp);
    }
  } finally {
    db.close();
    cleanup();
  }
});
