// Postgres companion to src/lib/db-indexes.ts. Same shape, different catalog.
//
// Three reads:
//   1. listPgIndexes      — pg_indexes view, filtered to the public schema
//   2. explainPgQueryPlan — EXPLAIN (FORMAT JSON) for a SQL string
//   3. suggestPgMissingIndexes — tables with > N rows and zero non-pkey indexes
//
// Async-only. The Postgres backend has no sync surface, and the operator
// usage pattern is one-shot (`sign db indexes-postgres --pg-url …`).

import type { DbBackend } from "./db-backend.js";
import { SignCliError } from "./sign-error.js";

export type PgIndexInfo = {
  name: string;
  table: string;
  schema: string;
  unique: boolean;
  primary: boolean;
  // The original CREATE INDEX statement, exactly as Postgres reports it.
  // Most operators want this verbatim — paste it into a script and you have
  // a re-creation step.
  definition: string;
};

export async function listPgIndexes(backend: DbBackend, schema = "public"): Promise<PgIndexInfo[]> {
  ensurePostgres(backend);
  const rows = await backend.prepareAsync(
    `SELECT i.indexname AS name,
            i.tablename  AS table_name,
            i.schemaname AS schema,
            i.indexdef   AS definition,
            COALESCE(ix.indisunique, false) AS is_unique,
            COALESCE(ix.indisprimary, false) AS is_primary
     FROM pg_indexes i
     JOIN pg_class c ON c.relname = i.indexname
     JOIN pg_index ix ON ix.indexrelid = c.oid
     WHERE i.schemaname = ?
     ORDER BY i.tablename, i.indexname`,
  ).all(schema) as Array<{
    name: string;
    table_name: string;
    schema: string;
    definition: string;
    is_unique: boolean;
    is_primary: boolean;
  }>;
  return rows.map((row) => ({
    name: row.name,
    table: row.table_name,
    schema: row.schema,
    unique: Boolean(row.is_unique),
    primary: Boolean(row.is_primary),
    definition: row.definition,
  }));
}

export type PgQueryPlan = {
  raw: unknown; // EXPLAIN (FORMAT JSON) returns a single jsonb column with the full plan tree
};

export async function explainPgQueryPlan(backend: DbBackend, sql: string): Promise<PgQueryPlan> {
  ensurePostgres(backend);
  // pg's EXPLAIN doesn't accept parameters via prepared-statement protocol when
  // the inner statement has its own placeholders, so callers should pass a
  // resolved SQL string. We don't translate "?" here — EXPLAIN is operator
  // tooling, not a hot path.
  const rows = await backend.prepareAsync(`EXPLAIN (FORMAT JSON) ${sql}`).all() as Array<{
    "QUERY PLAN"?: unknown;
    query_plan?: unknown;
  }>;
  // The pg driver returns the column as `QUERY PLAN` with the literal space,
  // depending on pg version it may also be lowercased. Normalize.
  const first = rows[0] ?? {};
  return { raw: first["QUERY PLAN"] ?? first.query_plan ?? first };
}

export type PgIndexSuggestion = {
  table: string;
  rowCount: number;
  reason: string;
};

export async function suggestPgMissingIndexes(
  backend: DbBackend,
  suggestRowThreshold = 1000,
  schema = "public",
): Promise<PgIndexSuggestion[]> {
  ensurePostgres(backend);
  // pg_class.reltuples is an estimate maintained by ANALYZE. We use it instead
  // of COUNT(*) per table so this query is cheap on huge tables.
  const rows = await backend.prepareAsync(
    `SELECT c.relname AS table_name, c.reltuples::bigint AS row_estimate,
            (SELECT COUNT(*) FROM pg_index ix WHERE ix.indrelid = c.oid AND NOT ix.indisprimary) AS user_index_count
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = ?
     ORDER BY c.relname`,
  ).all(schema) as Array<{ table_name: string; row_estimate: number | string; user_index_count: number | string }>;

  const out: PgIndexSuggestion[] = [];
  for (const row of rows) {
    const rowCount = Number(row.row_estimate);
    const userIndexCount = Number(row.user_index_count);
    if (userIndexCount > 0) continue;
    if (rowCount >= suggestRowThreshold) {
      out.push({
        table: row.table_name,
        rowCount,
        reason: `Table has ~${rowCount} rows (pg_class.reltuples estimate) but no non-pkey indexes; consider one for any column you filter or sort by.`,
      });
    }
  }
  return out;
}

function ensurePostgres(backend: DbBackend): void {
  if (backend.kind !== "postgres") {
    throw new SignCliError({
      code: "INVALID_ARGS",
      message: `db indexes-postgres requires a PostgresBackend; got kind="${backend.kind}".`,
    });
  }
}
