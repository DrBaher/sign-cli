import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyPendingMigrations } from "./migrations.js";
import { SignCliError } from "./sign-error.js";

export type SqliteDb = DatabaseSync;

function hasColumn(db: SqliteDb, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

export function openDatabase(dbPath: string): SqliteDb {
  const resolved = path.resolve(dbPath);
  const parentDir = path.dirname(resolved);
  try {
    mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    // Wrap filesystem permission errors into a structured SignCliError so
    // callers get a stable code + hint instead of a raw Node.js stack.
    // Common failure modes:
    //   EACCES — parent dir not writable
    //   EROFS  — read-only filesystem (e.g. mounted CD/initramfs)
    //   ENOENT — parent of parent is missing AND recursive:true couldn't
    //            help (rare; e.g. on /dev/null)
    const e = err as { code?: string; message?: string };
    if (e.code === "EACCES" || e.code === "EROFS" || e.code === "EPERM") {
      throw new SignCliError({
        code: "STORAGE_UNWRITABLE",
        message: `Cannot create database directory ${parentDir}: ${e.message ?? e.code}`,
        hint:
          `Either chmod/chown the parent directory so the current user can write to it, ` +
          `set SIGN_DB_PATH to a writable location (e.g. /tmp/sign.db or ~/.sign-cli/main.db), ` +
          `or pick a profile whose dbPath points somewhere writable.`,
      });
    }
    throw err; // Other failures (ENOENT on a truly broken path, etc.) bubble up.
  }
  const db = new DatabaseSync(resolved);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
  } catch {
    // Best-effort; continue with default journal mode.
  }
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      document_path TEXT NOT NULL,
      document_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      provider TEXT,
      provider_request_id TEXT,
      provider_status TEXT,
      dropbox_signature_request_id TEXT,
      dropbox_status TEXT,
      signature_ids_json TEXT,
      signers_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      signer_name TEXT NOT NULL,
      signer_email TEXT NOT NULL,
      signer_order INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_hint TEXT NOT NULL,
      doc_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      approved_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      hash_prev TEXT,
      hash_self TEXT NOT NULL,
      hash_algo TEXT NOT NULL DEFAULT 'sha256',
      created_at TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );

    CREATE TABLE IF NOT EXISTS webhook_dedupe (
      provider TEXT NOT NULL,
      event_key TEXT NOT NULL,
      request_id TEXT,
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (provider, event_key)
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      request_id TEXT,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );

    CREATE TABLE IF NOT EXISTS signer_signing_states (
      request_id TEXT NOT NULL,
      signer_email TEXT NOT NULL,
      signer_name TEXT,
      signed_at TEXT,
      declined_at TEXT,
      decline_reason TEXT,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (request_id, signer_email),
      FOREIGN KEY (request_id) REFERENCES requests(id)
    );
  `);

  if (!hasColumn(db, "requests", "signature_ids_json")) {
    db.exec("ALTER TABLE requests ADD COLUMN signature_ids_json TEXT");
  }
  if (!hasColumn(db, "requests", "provider")) {
    db.exec("ALTER TABLE requests ADD COLUMN provider TEXT");
  }
  if (!hasColumn(db, "requests", "provider_request_id")) {
    db.exec("ALTER TABLE requests ADD COLUMN provider_request_id TEXT");
  }
  if (!hasColumn(db, "requests", "provider_status")) {
    db.exec("ALTER TABLE requests ADD COLUMN provider_status TEXT");
  }
  if (!hasColumn(db, "requests", "documents_json")) {
    db.exec("ALTER TABLE requests ADD COLUMN documents_json TEXT");
  }
  if (!hasColumn(db, "requests", "fields_json")) {
    db.exec("ALTER TABLE requests ADD COLUMN fields_json TEXT");
  }
  if (!hasColumn(db, "requests", "template_id")) {
    db.exec("ALTER TABLE requests ADD COLUMN template_id TEXT");
  }
  if (!hasColumn(db, "requests", "prefills_json")) {
    db.exec("ALTER TABLE requests ADD COLUMN prefills_json TEXT");
  }
  if (!hasColumn(db, "audit_events", "hash_algo")) {
    // Existing rows were written with the unkeyed SHA-256 scheme; default
    // them to 'sha256' so verifyChainRows keeps validating them unchanged.
    db.exec("ALTER TABLE audit_events ADD COLUMN hash_algo TEXT NOT NULL DEFAULT 'sha256'");
  }

  installAuditAppendOnlyTriggers(db);

  // Apply versioned migrations after the baseline + ad-hoc ALTERs above so
  // any new index/column additions can rely on the full table set.
  applyPendingMigrations(db);

  return db;
}


const AUDIT_NO_UPDATE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS audit_events_no_update
  BEFORE UPDATE ON audit_events
  BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only; UPDATE not permitted');
  END;
`;
const AUDIT_NO_DELETE_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
  BEFORE DELETE ON audit_events
  BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only; DELETE not permitted');
  END;
`;

export function installAuditAppendOnlyTriggers(db: SqliteDb): void {
  db.exec(AUDIT_NO_UPDATE_TRIGGER);
  db.exec(AUDIT_NO_DELETE_TRIGGER);
}

export function dropAuditAppendOnlyTriggers(db: SqliteDb): void {
  db.exec(`
    DROP TRIGGER IF EXISTS audit_events_no_update;
    DROP TRIGGER IF EXISTS audit_events_no_delete;
  `);
}

// Test-only helper. Drops the audit append-only triggers, runs `fn`, then
// re-installs them. Use from tests that simulate an attacker bypassing the
// guard to verify the hash-chain still catches the tamper.
export function withAuditTamperingAllowed<T>(db: SqliteDb, fn: () => T): T {
  dropAuditAppendOnlyTriggers(db);
  try {
    return fn();
  } finally {
    installAuditAppendOnlyTriggers(db);
  }
}
