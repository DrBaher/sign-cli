import test from "node:test";
import assert from "node:assert/strict";
import {
  explainPgQueryPlan,
  listPgIndexes,
  suggestPgMissingIndexes,
} from "../lib/db-indexes-postgres.js";
import { PostgresBackend, wrapSqliteDb, type PgQueryable } from "../lib/db-backend.js";
import { SignCliError } from "../lib/sign-error.js";
import { createDb, makeTempDb } from "./helpers.js";

function makeFakeClient(handler: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>): PgQueryable {
  return { query: handler };
}

test("listPgIndexes maps pg_indexes rows + pg_index flags into the canonical shape", async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const backend = new PostgresBackend(makeFakeClient(async (text, params) => {
    calls.push({ text, params });
    return {
      rows: [
        {
          name: "requests_pkey",
          table_name: "requests",
          schema: "public",
          definition: "CREATE UNIQUE INDEX requests_pkey ON public.requests USING btree (id)",
          is_unique: true,
          is_primary: true,
        },
        {
          name: "approvals_token_hash_key",
          table_name: "approvals",
          schema: "public",
          definition: "CREATE UNIQUE INDEX approvals_token_hash_key ON public.approvals USING btree (token_hash)",
          is_unique: true,
          is_primary: false,
        },
      ],
      rowCount: 2,
    };
  }));
  const indexes = await listPgIndexes(backend);
  assert.equal(indexes.length, 2);
  assert.equal(indexes[0].name, "requests_pkey");
  assert.equal(indexes[0].primary, true);
  assert.equal(indexes[1].unique, true);
  assert.equal(indexes[1].primary, false);
  assert.equal(calls[0].params?.[0], "public");
  // Placeholder translation: ? → $1
  assert.ok(calls[0].text.includes("$1"));
});

test("explainPgQueryPlan returns the QUERY PLAN column verbatim", async () => {
  const fakePlan = [{ Plan: { "Node Type": "Seq Scan", Relation: "requests" } }];
  const backend = new PostgresBackend(makeFakeClient(async () => ({
    rows: [{ "QUERY PLAN": fakePlan }],
    rowCount: 1,
  })));
  const result = await explainPgQueryPlan(backend, "SELECT * FROM requests");
  assert.deepEqual(result.raw, fakePlan);
});

test("suggestPgMissingIndexes flags only large tables with zero non-pkey indexes", async () => {
  const backend = new PostgresBackend(makeFakeClient(async () => ({
    rows: [
      { table_name: "small", row_estimate: 50, user_index_count: 0 },
      { table_name: "big_indexed", row_estimate: 50000, user_index_count: 3 },
      { table_name: "big_naked", row_estimate: 50000, user_index_count: 0 },
    ],
    rowCount: 3,
  })));
  const suggestions = await suggestPgMissingIndexes(backend, 1000);
  const tables = suggestions.map((s) => s.table);
  assert.deepEqual(tables, ["big_naked"]);
  assert.equal(suggestions[0].rowCount, 50000);
});

test("listPgIndexes refuses to run against a SqliteBackend", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const backend = wrapSqliteDb(db);
    await assert.rejects(
      () => listPgIndexes(backend),
      (err: unknown) => err instanceof SignCliError && err.code === "INVALID_ARGS",
    );
  } finally {
    db.close();
    cleanup();
  }
});
