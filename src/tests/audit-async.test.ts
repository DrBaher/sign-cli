import test from "node:test";
import assert from "node:assert/strict";
import { searchAuditEventsAsync, verifyAuditChainAsync } from "../lib/audit.js";
import { listAuditEventsAsync, createSigningRequest } from "../lib/signing-service.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("verifyAuditChainAsync returns the same result as the sync version on SqliteBackend", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("async-verify");
  try {
    const created = createSigningRequest(db, {
      title: "Async verify",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const backend = wrapSqliteDb(db);
    const result = await verifyAuditChainAsync(backend, created.requestId);
    assert.equal(result.valid, true);
    assert.ok(result.events > 0);
  } finally {
    db.close();
    cleanup();
  }
});

test("listAuditEventsAsync returns rows shaped identically to the sync version", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("async-list");
  try {
    const created = createSigningRequest(db, {
      title: "Async list",
      documentPath,
      signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const backend = wrapSqliteDb(db);
    const rows = await listAuditEventsAsync(backend, created.requestId);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(typeof row.id, "number");
      assert.equal(typeof row.event_type, "string");
      assert.equal(typeof row.hash_self, "string");
    }
  } finally {
    db.close();
    cleanup();
  }
});

test("searchAuditEventsAsync runs through the backend's async surface and translates ? for Postgres", async () => {
  // Build a fake pg client that asserts $N placeholders and returns canned rows.
  const seen: Array<{ text: string; params?: unknown[] }> = [];
  const fakeClient: PgQueryable = {
    async query(text, params) {
      seen.push({ text, params });
      return {
        rows: [
          {
            id: 1,
            request_id: "req-x",
            event_type: "request.created",
            payload_json: '{"hello":"world"}',
            hash_self: "abc",
            created_at: "2026-05-01T00:00:00Z",
          },
        ],
        rowCount: 1,
      };
    },
  };
  const backend = new PostgresBackend(fakeClient);
  const result = await searchAuditEventsAsync(backend, { requestId: "req-x", eventType: "request.created" });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].requestId, "req-x");
  assert.deepEqual(result.results[0].payload, { hello: "world" });
  // Confirm placeholder translation happened: SQL has $1, $2 (no "?").
  assert.ok(seen[0].text.includes("$1"));
  assert.ok(seen[0].text.includes("$2"));
  assert.ok(!seen[0].text.includes("?"));
});
