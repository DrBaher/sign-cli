import test from "node:test";
import assert from "node:assert/strict";
import { runPostgresSmoke } from "../lib/postgres-smoke.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { SignCliError } from "../lib/sign-error.js";
import { createDb, makeTempDb } from "./helpers.js";

// In-memory pg fake: routes a small subset of the SQL the smoke runs through
// to in-memory state. Enough to make the probe pass end-to-end against
// PostgresBackend without a real Postgres instance.
type FakeRow = Record<string, unknown>;
function makeInMemoryFakePg(): PgQueryable {
  const tables: Record<string, FakeRow[]> = { requests: [], audit_events: [] };
  let nextEventId = 1;
  return {
    async query(text, params = []) {
      const sql = text.trim();
      // DDL — accept silently.
      if (/^(CREATE|DROP|REPLACE|--)/i.test(sql) ||
          sql.startsWith("CREATE OR REPLACE FUNCTION") ||
          sql.startsWith("DROP TRIGGER")) {
        return { rows: [], rowCount: 0 };
      }
      if (/^INSERT INTO requests/i.test(sql)) {
        const [id, title, document_path, document_hash, status, signers_json, created_at, updated_at] = params as unknown[];
        tables.requests.push({ id, title, document_path, document_hash, status, signers_json, created_at, updated_at });
        return { rows: [], rowCount: 1 };
      }
      if (/^INSERT INTO audit_events/i.test(sql)) {
        const [request_id, event_type, payload_json, hash_prev, hash_self, created_at] = params as unknown[];
        tables.audit_events.push({ id: nextEventId++, request_id, event_type, payload_json, hash_prev, hash_self, created_at });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT hash_self\s+FROM audit_events\s+WHERE request_id = \$1\s+ORDER BY id DESC\s+LIMIT 1/i.test(sql)) {
        const requestId = (params as unknown[])[0];
        const matching = tables.audit_events.filter((r) => r.request_id === requestId);
        const last = matching[matching.length - 1];
        return { rows: last ? [{ hash_self: last.hash_self }] : [], rowCount: last ? 1 : 0 };
      }
      if (/^SELECT id, request_id, event_type, payload_json, hash_prev, hash_self, created_at\s+FROM audit_events\s+WHERE request_id = \$1\s+ORDER BY id ASC/i.test(sql)) {
        const requestId = (params as unknown[])[0];
        const rows = tables.audit_events.filter((r) => r.request_id === requestId);
        return { rows, rowCount: rows.length };
      }
      if (/^SELECT id, event_type, payload_json, hash_prev, hash_self, created_at\s+FROM audit_events\s+WHERE request_id = \$1\s+ORDER BY id ASC/i.test(sql)) {
        const requestId = (params as unknown[])[0];
        const rows = tables.audit_events
          .filter((r) => r.request_id === requestId)
          .map(({ id, event_type, payload_json, hash_prev, hash_self, created_at }) => ({ id, event_type, payload_json, hash_prev, hash_self, created_at }));
        return { rows, rowCount: rows.length };
      }
      if (/^SELECT id, request_id, event_type, payload_json, hash_self, created_at\s+FROM audit_events/i.test(sql)) {
        // searchAuditEventsAsync — apply request_id and event_type filters.
        let rows = tables.audit_events.slice();
        // Naive param positioning — request_id then event_type for the smoke.
        const requestId = (params as unknown[])[0];
        const eventType = (params as unknown[])[1];
        if (typeof requestId === "string") rows = rows.filter((r) => r.request_id === requestId);
        if (typeof eventType === "string") rows = rows.filter((r) => r.event_type === eventType);
        rows = rows.sort((a, b) => Number(b.id) - Number(a.id));
        return { rows: rows.map(({ id, request_id, event_type, payload_json, hash_self, created_at }) => ({ id, request_id, event_type, payload_json, hash_self, created_at })), rowCount: rows.length };
      }
      throw new Error(`fake-pg: unhandled SQL: ${sql.slice(0, 80)}…`);
    },
  };
}

test("runPostgresSmoke runs every step ok against an in-memory pg fake", async () => {
  const backend = new PostgresBackend(makeInMemoryFakePg());
  const report = await runPostgresSmoke(backend);
  assert.equal(report.ok, true, `steps: ${JSON.stringify(report.steps, null, 2)}`);
  const stepNames = report.steps.map((s) => s.name);
  for (const expected of [
    "bootstrap-schema",
    "insert-request",
    "append-audit-event-1",
    "append-audit-event-2",
    "append-audit-event-3",
    "verify-chain",
    "list-audit-events",
    "search-audit-events",
  ]) {
    assert.ok(stepNames.includes(expected), `missing step ${expected}`);
  }
});

test("runPostgresSmoke refuses to run against a SqliteBackend", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const backend = wrapSqliteDb(db);
    await assert.rejects(
      () => runPostgresSmoke(backend),
      (err: unknown) => err instanceof SignCliError && err.code === "INVALID_ARGS",
    );
  } finally {
    db.close();
    cleanup();
  }
});
