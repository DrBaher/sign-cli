// Ops-friendly introspection over the SQLite catalog.
//
// Three things real operators ask:
//   1. "What indexes exist on this DB right now?" — listDbIndexes
//   2. "Will my query use an index?"               — explainQueryPlan
//   3. "Which tables look under-indexed?"          — suggestMissingIndexes
//
// SQLite-specific. The Postgres equivalent (pg_indexes) is a future PR; for
// now this is the SQLite operator's tool.

import type { SqliteDb } from "./db.js";

export type IndexInfo = {
  name: string;
  table: string;
  unique: boolean;
  partial: boolean;
  columns: string[];
  // The original CREATE INDEX SQL. NULL for SQLite's auto-created indexes
  // (pkey/UNIQUE) — those don't show up in sqlite_master with sql IS NOT NULL,
  // but we still report the implicit ones via PRAGMA index_list.
  sql: string | null;
};

export function listDbIndexes(db: SqliteDb): IndexInfo[] {
  const rows = db.prepare(
    `SELECT name, tbl_name AS table_name, sql
     FROM sqlite_master
     WHERE type = 'index'
     ORDER BY tbl_name, name`,
  ).all() as Array<{ name: string; table_name: string; sql: string | null }>;

  const indexes: IndexInfo[] = [];
  for (const row of rows) {
    // PRAGMA index_list returns one row per index per table, with unique/partial flags.
    const meta = db.prepare(`PRAGMA index_list(${quoteIdent(row.table_name)})`).all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const info = meta.find((m) => m.name === row.name);
    const cols = db.prepare(`PRAGMA index_info(${quoteIdent(row.name)})`).all() as Array<{
      name: string;
    }>;
    indexes.push({
      name: row.name,
      table: row.table_name,
      unique: Boolean(info?.unique ?? 0),
      partial: Boolean(info?.partial ?? 0),
      columns: cols.map((c) => c.name),
      sql: row.sql,
    });
  }
  return indexes;
}

export type QueryPlanStep = {
  id: number;
  parent: number;
  notused: number;
  detail: string;
};

export function explainQueryPlan(db: SqliteDb, sql: string): QueryPlanStep[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as QueryPlanStep[];
}

export type IndexSuggestion = {
  table: string;
  rowCount: number;
  reason: string;
};

// Light heuristic: any user-table with > suggestRowThreshold rows that has zero
// non-pkey/non-unique indexes is a candidate for one. This is a starting
// point — operators tune from EXPLAIN QUERY PLAN, not from this list alone.
export function suggestMissingIndexes(db: SqliteDb, suggestRowThreshold = 1000): IndexSuggestion[] {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all() as Array<{ name: string }>;
  const out: IndexSuggestion[] = [];
  for (const { name } of tables) {
    const indexList = db.prepare(`PRAGMA index_list(${quoteIdent(name)})`).all() as Array<{
      name: string;
      origin: string; // "c" = CREATE INDEX (user), "u" = UNIQUE constraint, "pk" = primary key
    }>;
    const userIndexes = indexList.filter((i) => i.origin === "c");
    if (userIndexes.length > 0) continue;
    const rowCountRow = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get() as { n: number };
    if (rowCountRow.n >= suggestRowThreshold) {
      out.push({
        table: name,
        rowCount: rowCountRow.n,
        reason: `Table has ${rowCountRow.n} rows but no user-created indexes; consider one for any column you filter or sort by.`,
      });
    }
  }
  return out;
}

// SQLite quoting for identifiers. Double quotes wrap; embedded " is doubled.
// Sticks to ASCII identifiers we control — the `name` columns from sqlite_master
// are always safe, but using a quoter is cheaper than rationalizing about that
// every call site.
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
