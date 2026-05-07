// DbBackend interface — the minimal shape that both SQLite and Postgres
// implementations need to satisfy so call sites can flip backends without
// touching their query code.
//
// Today this is a thin wrapper over `node:sqlite`'s DatabaseSync. The point
// of having it as a named interface is that future PRs can:
//   1. Add a PostgresBackend implementing the same shape (see the stub below).
//   2. Migrate one call site at a time from `SqliteDb` to `DbBackend`.
//   3. Eventually retire the `SqliteDb`-typed paths.
//
// We deliberately keep the surface tiny: prepare → run/get/all, plus exec/close.
// Anything richer (transactions, streaming, custom serializers) can be added
// when the second backend forces the issue.

import type { SqliteDb } from "./db.js";
import { SignCliError } from "./sign-error.js";

export type DbRow = Record<string, unknown>;

export interface DbStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): DbRow | undefined;
  all(...params: unknown[]): DbRow[];
}

export interface DbBackend {
  readonly kind: "sqlite" | "postgres";
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  close(): void;
}

// --- SQLite adapter ---------------------------------------------------------
// Trivial: DatabaseSync's prepare(...) result already exposes run/get/all with
// the right semantics. We just narrow + brand it.

class SqliteStatementAdapter implements DbStatement {
  constructor(private readonly inner: ReturnType<SqliteDb["prepare"]>) {}
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.inner.run(...(params as Parameters<typeof this.inner.run>));
    return {
      changes: Number(result.changes ?? 0),
      lastInsertRowid: result.lastInsertRowid as number | bigint,
    };
  }
  get(...params: unknown[]): DbRow | undefined {
    const row = this.inner.get(...(params as Parameters<typeof this.inner.get>));
    return row ? { ...(row as DbRow) } : undefined;
  }
  all(...params: unknown[]): DbRow[] {
    const rows = this.inner.all(...(params as Parameters<typeof this.inner.all>));
    return ((rows ?? []) as DbRow[]).map((row) => ({ ...row }));
  }
}

export class SqliteBackend implements DbBackend {
  readonly kind = "sqlite" as const;
  constructor(private readonly db: SqliteDb) {}
  prepare(sql: string): DbStatement {
    return new SqliteStatementAdapter(this.db.prepare(sql));
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  close(): void {
    this.db.close();
  }
}

// --- Postgres stub ----------------------------------------------------------
// Intentionally throws on every operation. Until we wire `pg`, we want any
// accidental `SIGN_DB_BACKEND=postgres` path to fail loudly with a pointer
// at the migration plan instead of silently degrading.

export class PostgresBackend implements DbBackend {
  readonly kind = "postgres" as const;
  constructor(private readonly _connectionUrl?: string) {}
  prepare(_sql: string): DbStatement {
    throw notImplemented("DbBackend.prepare");
  }
  exec(_sql: string): void {
    throw notImplemented("DbBackend.exec");
  }
  close(): void {
    // no-op — nothing to close on a stub
  }
}

function notImplemented(method: string): SignCliError {
  return new SignCliError({
    code: "INTERNAL",
    message:
      `${method} is not implemented for the postgres backend. ` +
      "The DbBackend interface scaffold lives at src/lib/db-backend.ts; the next PR in the " +
      "Postgres-readiness checklist (see MIGRATION.md) wires the `pg` driver into this stub.",
  });
}

// --- Helper -----------------------------------------------------------------

export function wrapSqliteDb(db: SqliteDb): DbBackend {
  return new SqliteBackend(db);
}
