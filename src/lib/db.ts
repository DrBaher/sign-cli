import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqliteDb = DatabaseSync;

function hasColumn(db: SqliteDb, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

export function openDatabase(dbPath: string): SqliteDb {
  const resolved = path.resolve(dbPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
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

  return db;
}
