import test from "node:test";
import assert from "node:assert/strict";
import {
  createSigningRequest,
  getRequestRowAsync,
  listSigningRequestsAsync,
  scanAllAuditChainsAsync,
  verifyRequestAuditChainAsync,
} from "../lib/signing-service.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("getRequestRowAsync / listSigningRequestsAsync / scanAllAuditChainsAsync / verifyRequestAuditChainAsync match the sync results on SqliteBackend", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("async-round2");
  try {
    const created = createSigningRequest(db, {
      title: "Round 2",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const backend = wrapSqliteDb(db);

    const row = await getRequestRowAsync(backend, created.requestId);
    assert.equal(row.id, created.requestId);
    assert.equal(row.title, "Round 2");

    const list = await listSigningRequestsAsync(backend);
    assert.ok(list.some((r) => r.id === created.requestId));
    assert.equal(list[0].provider, "dropbox");

    const verify = await verifyRequestAuditChainAsync(backend, created.requestId);
    assert.equal(verify.valid, true);

    const scan = await scanAllAuditChainsAsync(backend);
    assert.equal(scan.total, 1);
    assert.equal(scan.valid, 1);
    assert.equal(scan.invalid, 0);
  } finally {
    db.close();
    cleanup();
  }
});

test("listSigningRequestsAsync against PostgresBackend translates ? placeholders", async () => {
  const seen: Array<{ text: string; params?: unknown[] }> = [];
  const fakeClient: PgQueryable = {
    async query(text, params) {
      seen.push({ text, params });
      return {
        rows: [
          {
            id: "req-1",
            title: "From pg",
            status: "completed",
            provider: "dropbox",
            provider_request_id: null,
            provider_status: null,
            signers_json: '[{"email":"a@x.com"}]',
            created_at: "2026-05-01T00:00:00Z",
            updated_at: "2026-05-01T00:00:00Z",
          },
        ],
        rowCount: 1,
      };
    },
  };
  const backend = new PostgresBackend(fakeClient);
  const result = await listSigningRequestsAsync(backend, { provider: "dropbox", status: "completed" });
  assert.equal(result.length, 1);
  assert.equal(result[0].provider, "dropbox");
  assert.equal(result[0].signers, 1);
  // Confirm placeholder translation: $1, $2 present, no "?" in the final SQL.
  assert.ok(seen[0].text.includes("$1"));
  assert.ok(seen[0].text.includes("$2"));
  assert.ok(!seen[0].text.includes("?"));
});
