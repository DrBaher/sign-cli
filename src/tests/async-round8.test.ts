import test from "node:test";
import assert from "node:assert/strict";
import {
  createSigningRequest,
  reissueApprovalTokenRowAsync,
} from "../lib/signing-service.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("reissueApprovalTokenRowAsync flips token_hash + token_hint + expires_at on the SqliteBackend", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("reissue-async");
  try {
    const r = createSigningRequest(db, {
      title: "Reissue async",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const approval = db.prepare("SELECT id FROM approvals WHERE request_id = ? LIMIT 1")
      .get(r.requestId) as { id: string };
    const backend = wrapSqliteDb(db);
    await reissueApprovalTokenRowAsync(
      backend,
      approval.id,
      "ff".repeat(32),
      "abcd…wxyz",
      "2026-05-09T00:00:00Z",
    );
    const row = db.prepare("SELECT token_hash, token_hint, expires_at FROM approvals WHERE id = ?")
      .get(approval.id) as { token_hash: string; token_hint: string; expires_at: string };
    assert.equal(row.token_hash, "ff".repeat(32));
    assert.equal(row.token_hint, "abcd…wxyz");
    assert.equal(row.expires_at, "2026-05-09T00:00:00Z");
  } finally {
    db.close();
    cleanup();
  }
});

test("reissueApprovalTokenRowAsync against PostgresBackend uses translated $1..$4 placeholders", async () => {
  const seen: Array<{ text: string; params?: unknown[] }> = [];
  const fakeClient: PgQueryable = {
    async query(text, params) {
      seen.push({ text, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const backend = new PostgresBackend(fakeClient);
  await reissueApprovalTokenRowAsync(backend, "apr-1", "0".repeat(64), "hint…", "2026-05-09T00:00:00Z");
  assert.equal(seen.length, 1);
  for (let i = 1; i <= 4; i += 1) assert.ok(seen[0].text.includes(`$${i}`));
  assert.ok(!seen[0].text.includes("?"));
  assert.deepEqual(seen[0].params, ["0".repeat(64), "hint…", "2026-05-09T00:00:00Z", "apr-1"]);
});
