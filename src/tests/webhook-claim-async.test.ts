import test from "node:test";
import assert from "node:assert/strict";
import { tryClaimWebhookEventAsync } from "../lib/signing-service.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { createDb, makeTempDb } from "./helpers.js";

test("tryClaimWebhookEventAsync returns true on first claim, false on duplicate (SqliteBackend)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const backend = wrapSqliteDb(db);
    const first = await tryClaimWebhookEventAsync(backend, {
      provider: "dropbox",
      eventKey: "evt-1",
      requestId: null,
      now: new Date("2026-05-08T00:00:00Z"),
    });
    assert.equal(first, true);
    const second = await tryClaimWebhookEventAsync(backend, {
      provider: "dropbox",
      eventKey: "evt-1",
      requestId: null,
      now: new Date("2026-05-08T00:00:01Z"),
    });
    assert.equal(second, false, "duplicate claim should return false");
  } finally {
    db.close();
    cleanup();
  }
});

test("tryClaimWebhookEventAsync against PostgresBackend uses ON CONFLICT DO NOTHING (no INSERT OR IGNORE)", async () => {
  const seen: Array<{ text: string; params?: unknown[] }> = [];
  const fakeClient: PgQueryable = {
    async query(text, params) {
      seen.push({ text, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const backend = new PostgresBackend(fakeClient);
  const claimed = await tryClaimWebhookEventAsync(backend, {
    provider: "signwell",
    eventKey: "sw-evt",
    requestId: "req-1",
    now: new Date("2026-05-08T12:00:00Z"),
  });
  assert.equal(claimed, true);
  // Postgres dialect — uses ON CONFLICT, not OR IGNORE.
  assert.match(seen[0].text, /ON CONFLICT/);
  assert.ok(!seen[0].text.includes("OR IGNORE"));
  // Placeholders translated $1..$4
  for (let i = 1; i <= 4; i += 1) {
    assert.ok(seen[0].text.includes(`$${i}`));
  }
});

test("tryClaimWebhookEventAsync returns false when Postgres reports rowCount 0", async () => {
  const fakeClient: PgQueryable = {
    async query() { return { rows: [], rowCount: 0 }; },
  };
  const backend = new PostgresBackend(fakeClient);
  const claimed = await tryClaimWebhookEventAsync(backend, {
    provider: "docusign",
    eventKey: "ds-evt",
    requestId: "req-2",
    now: new Date("2026-05-08T12:00:00Z"),
  });
  assert.equal(claimed, false);
});
