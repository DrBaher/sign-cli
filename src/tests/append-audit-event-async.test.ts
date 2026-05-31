import test from "node:test";
import assert from "node:assert/strict";
import { appendAuditEvent, appendAuditEventAsync, verifyAuditChain } from "../lib/audit.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("appendAuditEventAsync extends the chain with the same hashSelf the sync path would compute (deterministic given the same payload + clock)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("async-append");
  try {
    const created = createSigningRequest(db, {
      title: "Async append",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const backend = wrapSqliteDb(db);
    const fixedNow = new Date("2026-05-08T12:00:00Z");
    const asyncResult = await appendAuditEventAsync(backend, {
      requestId: created.requestId,
      eventType: "test.async",
      payload: { hello: "world" },
      now: fixedNow,
    });
    assert.match(asyncResult.hashSelf, /^[0-9a-f]{64}$/);
    assert.equal(asyncResult.createdAt, "2026-05-08T12:00:00.000Z");

    // Chain still verifies after the async append.
    const verify = verifyAuditChain(db, created.requestId);
    assert.equal(verify.valid, true);

    // The append correctly read the current head: the next sync append
    // should chain off the async-written hash_self.
    const syncResult = appendAuditEvent(db, {
      requestId: created.requestId,
      eventType: "test.sync",
      payload: { hello: "after async" },
      now: new Date("2026-05-08T12:00:01Z"),
    });
    assert.equal(syncResult.hashPrev, asyncResult.hashSelf);
  } finally {
    db.close();
    cleanup();
  }
});

test("appendAuditEventAsync against a PostgresBackend issues the right SQL with translated $N placeholders", async () => {
  const seen: Array<{ text: string; params?: unknown[] }> = [];
  const fakeClient: PgQueryable = {
    async query(text, params) {
      seen.push({ text, params });
      // SELECT prev → first call returns no row.
      // INSERT → second call returns rowCount 1.
      if (text.includes("INSERT")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const backend = new PostgresBackend(fakeClient);
  await appendAuditEventAsync(backend, {
    requestId: "req-x",
    eventType: "test",
    payload: { k: "v" },
    now: new Date("2026-05-08T12:00:00Z"),
  });
  assert.equal(seen.length, 2);
  // Both queries went through the placeholder translator.
  for (const call of seen) {
    assert.ok(!call.text.includes("?"), `query should not contain '?' after translation: ${call.text}`);
    assert.ok(/\$1/.test(call.text), `query should reference $1: ${call.text}`);
  }
  // The INSERT receives 7 params (request_id, event_type, payload_json,
  // hash_prev, hash_self, hash_algo, created_at).
  const insertCall = seen.find((c) => c.text.includes("INSERT"));
  assert.equal(insertCall!.params!.length, 7);
});
