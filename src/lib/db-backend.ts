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

// Async variant. Postgres can only implement this — `pg` is async-only.
// SqliteBackend implements it too (synchronously, just Promise-wrapped) so
// new code can target the async surface uniformly.
export interface AsyncDbStatement {
  run(...params: unknown[]): Promise<{ changes: number }>;
  get(...params: unknown[]): Promise<DbRow | undefined>;
  all(...params: unknown[]): Promise<DbRow[]>;
}

export interface DbBackend {
  readonly kind: "sqlite" | "postgres";
  prepare(sql: string): DbStatement;
  prepareAsync(sql: string): AsyncDbStatement;
  exec(sql: string): void;
  execAsync(sql: string): Promise<void>;
  // Async-or-sync — Postgres needs `pool.end()` (async); SQLite is sync. Caller
  // can `await` either safely.
  close(): void | Promise<void>;
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
  prepareAsync(sql: string): AsyncDbStatement {
    const sync = new SqliteStatementAdapter(this.db.prepare(sql));
    return {
      run: async (...params) => ({ changes: sync.run(...params).changes }),
      get: async (...params) => sync.get(...params),
      all: async (...params) => sync.all(...params),
    };
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }
  close(): void {
    this.db.close();
  }
}

// --- Postgres backend -------------------------------------------------------
// Real implementation: backed by `pg.Pool` with on-the-fly placeholder
// translation. Sync (`prepare`/`exec`) still throws — `pg` is async-only and
// the sync→async call-site migration is its own track tracked in MIGRATION.md.
// `prepareAsync`/`execAsync` are the working entry points.

// Minimal subset of pg's Pool we depend on. Lets tests pass a fake without
// pulling in the real `pg` module — and matches `pg.Pool`'s real shape so
// the live driver is just `new pg.Pool({ connectionString })`.
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end?(): Promise<void>;
}

// Translate "?" placeholders (SQLite/sign-cli flavor) to "$1, $2, ..." (Postgres
// flavor). Pure: doesn't peek inside string literals, but we don't use ? inside
// literals anywhere, so the simple substitution is safe for our query corpus.
// Single-quoted literals are skipped to avoid mangling user-supplied data.
export function translatePlaceholders(sql: string): string {
  let out = "";
  let i = 0;
  let n = 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      // Copy the entire single-quoted literal verbatim, including any '' escapes.
      const end = findClosingSingleQuote(sql, i);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "?") {
      out += `$${n}`;
      n += 1;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function findClosingSingleQuote(sql: string, openIdx: number): number {
  let i = openIdx + 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") {
        i += 2; // doubled quote = escaped, skip both
        continue;
      }
      return i;
    }
    i += 1;
  }
  return sql.length - 1;
}

export class PostgresBackend implements DbBackend {
  readonly kind = "postgres" as const;
  constructor(private readonly client: PgQueryable, private readonly _connectionUrl?: string) {}
  prepare(_sql: string): DbStatement {
    throw new SignCliError({
      code: "INTERNAL",
      message:
        "PostgresBackend.prepare (sync) is not supported — pg is async-only. Use prepareAsync(). " +
        "Sync→async call-site migration is tracked in MIGRATION.md.",
    });
  }
  exec(_sql: string): void {
    throw new SignCliError({
      code: "INTERNAL",
      message: "PostgresBackend.exec (sync) is not supported. Use execAsync().",
    });
  }
  prepareAsync(sql: string): AsyncDbStatement {
    const translated = translatePlaceholders(sql);
    const client = this.client;
    return {
      async run(...params: unknown[]): Promise<{ changes: number }> {
        const result = await client.query(translated, params);
        return { changes: result.rowCount ?? 0 };
      },
      async get(...params: unknown[]): Promise<DbRow | undefined> {
        const result = await client.query(translated, params);
        const row = result.rows[0] as DbRow | undefined;
        return row ? { ...row } : undefined;
      },
      async all(...params: unknown[]): Promise<DbRow[]> {
        const result = await client.query(translated, params);
        return (result.rows as DbRow[]).map((row) => ({ ...row }));
      },
    };
  }
  async execAsync(sql: string): Promise<void> {
    await this.client.query(sql);
  }
  async close(): Promise<void> {
    if (this.client.end) await this.client.end();
  }
}

// --- Helpers ----------------------------------------------------------------

export function wrapSqliteDb(db: SqliteDb): DbBackend {
  return new SqliteBackend(db);
}

export function isDbBackend(value: unknown): value is DbBackend {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as { kind: unknown }).kind === "string" &&
    typeof (value as { prepare?: unknown }).prepare === "function"
  );
}

// Idempotent: returns the value as-is if it already implements DbBackend, otherwise
// wraps a raw SqliteDb. Lets a function take `SqliteDb | DbBackend` while only
// dealing with `DbBackend` internally — useful for the gradual call-site
// migration tracked in MIGRATION.md.
export function asBackend(db: SqliteDb | DbBackend): DbBackend {
  return isDbBackend(db) ? db : wrapSqliteDb(db);
}
