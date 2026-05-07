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

import { openDatabase, type SqliteDb } from "./db.js";
import { type DbBackend, PostgresBackend, wrapSqliteDb } from "./db-backend.js";
import { SignCliError } from "./sign-error.js";

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
// migrate one at a time. The Postgres branch is wired to the stub adapter so
// callers see a uniform error surface (DbBackend.prepare(...) throws) instead
// of the storage-level "implementation is a stub" envelope.
export function openStorageBackend(opts: StorageOpenOptions = {}): DbBackend {
  const backend = resolveBackend(opts.backend);
  if (backend === "postgres") {
    return new PostgresBackend(opts.postgresUrl ?? process.env.SIGN_PG_URL);
  }
  const dbPath = opts.dbPath ?? process.env.SIGN_DB_PATH ?? "./data/sign.db";
  return wrapSqliteDb(openDatabase(dbPath));
}
