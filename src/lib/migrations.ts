import type { SqliteDb } from "./db.js";
import { nowIso } from "./util.js";

export type Migration = {
  id: number;
  name: string;
  up: (db: SqliteDb) => void;
};

// Versioned migrations applied in order on openDatabase. Each migration runs
// at most once per DB (tracked in schema_migrations). When you add a new one,
// give it the next sequential id and a short kebab-case name.
//
// The baseline schema lives in db.ts's CREATE TABLE IF NOT EXISTS block — the
// migrations registry is for changes that need ordering or one-time data
// fixups.
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "audit-events-request-id-index",
    up: (db) => {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_audit_events_request_id_created_at ON audit_events(request_id, created_at)",
      );
    },
  },
  {
    id: 2,
    name: "signer-signing-states-source-index",
    up: (db) => {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_signer_signing_states_source ON signer_signing_states(source)",
      );
    },
  },
];

export function ensureSchemaMigrationsTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

export type AppliedMigration = { id: number; name: string; applied_at: string };

export function listAppliedMigrations(db: SqliteDb): AppliedMigration[] {
  ensureSchemaMigrationsTable(db);
  return db.prepare(
    "SELECT id, name, applied_at FROM schema_migrations ORDER BY id ASC",
  ).all() as AppliedMigration[];
}

export type MigrationOutcome = {
  alreadyApplied: AppliedMigration[];
  newlyApplied: AppliedMigration[];
  pending: Array<Pick<Migration, "id" | "name">>;
};

export function applyPendingMigrations(
  db: SqliteDb,
  opts: { dryRun?: boolean; now?: Date } = {},
): MigrationOutcome {
  ensureSchemaMigrationsTable(db);
  const applied = new Map<number, AppliedMigration>(
    listAppliedMigrations(db).map((row) => [row.id, row]),
  );
  const newlyApplied: AppliedMigration[] = [];
  const pending: Array<Pick<Migration, "id" | "name">> = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    if (opts.dryRun) {
      pending.push({ id: migration.id, name: migration.name });
      continue;
    }
    migration.up(db);
    const appliedAt = nowIso(opts.now ?? new Date());
    db.prepare(
      "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
    ).run(migration.id, migration.name, appliedAt);
    newlyApplied.push({ id: migration.id, name: migration.name, applied_at: appliedAt });
  }
  return {
    alreadyApplied: [...applied.values()],
    newlyApplied,
    pending,
  };
}
