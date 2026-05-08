import test from "node:test";
import assert from "node:assert/strict";
import { insertApprovalRowAsync } from "../lib/signing-service.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("insertApprovalRowAsync persists a new approval row that listApprovalRows can find (SqliteBackend)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("insert-approval-async");
  try {
    const created = createSigningRequest(db, {
      title: "Async approval",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const backend = wrapSqliteDb(db);
    await insertApprovalRowAsync(backend, {
      id: "apr-async-test",
      requestId: created.requestId,
      signerName: "Bob",
      signerEmail: "bob@example.com",
      signerOrder: 2,
      tokenHash: "deadbeef".repeat(8),
      tokenHint: "abcd…wxyz",
      docHash: "ff".repeat(32),
      expiresAt: "2026-05-09T00:00:00Z",
      createdAt: "2026-05-08T12:00:00Z",
    });
    const row = db.prepare(
      "SELECT signer_name, signer_email, signer_order FROM approvals WHERE id = ?",
    ).get("apr-async-test") as { signer_name: string; signer_email: string; signer_order: number } | undefined;
    assert.ok(row);
    assert.equal(row!.signer_name, "Bob");
    assert.equal(row!.signer_email, "bob@example.com");
    assert.equal(row!.signer_order, 2);
  } finally {
    db.close();
    cleanup();
  }
});

test("insertApprovalRowAsync against PostgresBackend uses translated $N placeholders + 12 params", async () => {
  const seen: Array<{ text: string; params?: unknown[] }> = [];
  const fakeClient: PgQueryable = {
    async query(text, params) {
      seen.push({ text, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const backend = new PostgresBackend(fakeClient);
  await insertApprovalRowAsync(backend, {
    id: "apr-1",
    requestId: "req-1",
    signerName: "Carol",
    signerEmail: "carol@example.com",
    signerOrder: 1,
    tokenHash: "0".repeat(64),
    tokenHint: "carol-…",
    docHash: "1".repeat(64),
    expiresAt: "2026-05-09T00:00:00Z",
    createdAt: "2026-05-08T12:00:00Z",
  });
  assert.equal(seen.length, 1);
  // Twelve placeholders → $1..$12, no "?" survives.
  for (let i = 1; i <= 12; i += 1) {
    assert.ok(seen[0].text.includes(`$${i}`), `query should reference $${i}`);
  }
  assert.ok(!seen[0].text.includes("?"));
  assert.equal(seen[0].params?.length, 12);
});
