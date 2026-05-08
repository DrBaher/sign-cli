// Storage backend abstraction. Today the only real implementation is SQLite
// (via openDatabase in db.ts). This module exists so we can grow toward a
// pluggable backend (Postgres for multi-tenant, etc.) without breaking the
// `SqliteDb` shape callers already depend on.
//
// Phase 1 (this PR): expose a tiny dispatcher that resolves SIGN_DB_BACKEND
//   sqlite (default)  → openDatabase(path)
//   postgres          → throws BACKEND_NOT_IMPLEMENTED with a clear pointer
//
// Phase 2 (future PR): introduce a minimal interface (prepare/exec) that
//   both backends implement, and migrate the call sites to it.

import { createRequire } from "node:module";
import { openDatabase, type SqliteDb } from "./db.js";
import { type DbBackend, type PgQueryable, PostgresBackend, wrapSqliteDb } from "./db-backend.js";
import { SignCliError } from "./sign-error.js";

const localRequire = createRequire(import.meta.url);

export type SignBackend = "sqlite" | "postgres";

export const SUPPORTED_BACKENDS: ReadonlyArray<SignBackend> = ["sqlite", "postgres"];

export function resolveBackend(explicit?: string): SignBackend {
  const raw = (explicit ?? process.env.SIGN_DB_BACKEND ?? "sqlite").trim().toLowerCase();
  if (raw === "sqlite" || raw === "postgres") return raw;
  throw new SignCliError({
    code: "INVALID_ARGS",
    message: `Unsupported SIGN_DB_BACKEND="${raw}". Expected one of: ${SUPPORTED_BACKENDS.join(", ")}.`,
  });
}

export type StorageInfo = {
  backend: SignBackend;
  ready: boolean;
  notes?: string;
};

export function describeBackend(backend: SignBackend): StorageInfo {
  if (backend === "sqlite") {
    return { backend, ready: true, notes: "Production-ready. Default. Backed by node:sqlite." };
  }
  return {
    backend,
    ready: false,
    notes:
      "Not implemented yet. The interface stub lives at src/lib/storage.ts so future PRs can wire pg without churn — see MIGRATION.md for the design notes.",
  };
}

export type StorageOpenOptions = {
  backend?: SignBackend;
  dbPath?: string;
  postgresUrl?: string;
};

// Today returns SqliteDb directly (the existing call surface). When Postgres
// lands, this signature widens to a tagged union and call sites narrow.
export function openStorage(opts: StorageOpenOptions = {}): SqliteDb {
  const backend = resolveBackend(opts.backend);
  if (backend === "postgres") {
    throw new SignCliError({
      code: "INTERNAL",
      message:
        "Postgres backend is declared in SIGN_DB_BACKEND but the implementation is a stub. " +
        "Track the migration in MIGRATION.md; until then, run with SIGN_DB_BACKEND=sqlite (the default).",
      details: { backend, postgresUrl: opts.postgresUrl ?? null },
    });
  }
  const dbPath = opts.dbPath ?? process.env.SIGN_DB_PATH ?? "./data/sign.db";
  return openDatabase(dbPath);
}

// Forward-compatible variant that returns the abstract DbBackend instead of the
// concrete SqliteDb. New code should reach for this; existing call sites can
// migrate one at a time.
//
// Postgres path is real now — it lazy-loads `pg`, builds a Pool, wraps it in
// PostgresBackend. The sync surface still throws (pg is async-only); callers
// must use `prepareAsync`/`execAsync`. Sync→async call-site migration is
// tracked in MIGRATION.md.
export function openStorageBackend(opts: StorageOpenOptions = {}): DbBackend {
  const backend = resolveBackend(opts.backend);
  if (backend === "postgres") {
    const url = opts.postgresUrl ?? process.env.SIGN_PG_URL;
    if (!url) {
      throw new SignCliError({
        code: "INVALID_ARGS",
        message: "SIGN_DB_BACKEND=postgres requires SIGN_PG_URL (or opts.postgresUrl) to be set.",
      });
    }
    return openPostgresBackend(url);
  }
  const dbPath = opts.dbPath ?? process.env.SIGN_DB_PATH ?? "./data/sign.db";
  return wrapSqliteDb(openDatabase(dbPath));
}

// Separated out so tests can stub the pg-loading path. Uses createRequire so
// SQLite-only users don't pay the import cost (and don't need `pg` installed
// at all unless they opt into Postgres).
function openPostgresBackend(connectionString: string): DbBackend {
  const pgMod = localRequire("pg") as { Pool: new (config: { connectionString: string }) => unknown };
  const pool = new pgMod.Pool({ connectionString }) as unknown as PgQueryable;
  return new PostgresBackend(pool, connectionString);
}
