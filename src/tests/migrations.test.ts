import test from "node:test";
import assert from "node:assert/strict";
import { applyPendingMigrations, listAppliedMigrations, MIGRATIONS } from "../lib/migrations.js";
import { createDb, makeTempDb } from "./helpers.js";

test("openDatabase auto-applies all pending migrations on first open", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const applied = listAppliedMigrations(db);
    const ids = applied.map((row) => row.id).sort();
    const expected = MIGRATIONS.map((m) => m.id).sort();
    assert.deepEqual(ids, expected, `expected all ${expected.length} migrations applied; got ${ids.length}`);
  } finally {
    db.close();
    cleanup();
  }
});

test("applyPendingMigrations is idempotent on a re-opened DB", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const before = listAppliedMigrations(db);
    const outcome = applyPendingMigrations(db);
    assert.equal(outcome.newlyApplied.length, 0, "second invocation must be a no-op");
    const after = listAppliedMigrations(db);
    assert.equal(after.length, before.length);
  } finally {
    db.close();
    cleanup();
  }
});

test("applyPendingMigrations --dryRun reports pending without mutating", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    // Pretend we haven't applied anything yet.
    db.exec("DELETE FROM schema_migrations");
    const dry = applyPendingMigrations(db, { dryRun: true });
    assert.equal(dry.newlyApplied.length, 0);
    assert.equal(dry.pending.length, MIGRATIONS.length);
    // Schema_migrations is still empty.
    const rows = db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number };
    assert.equal(rows.n, 0);
    // Real run picks them all up.
    const real = applyPendingMigrations(db);
    assert.equal(real.newlyApplied.length, MIGRATIONS.length);
  } finally {
    db.close();
    cleanup();
  }
});

test("indexes created by migrations are queryable in sqlite_master", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const indexNames = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all() as Array<{ name: string }>).map((r) => r.name);
    assert.ok(
      indexNames.includes("idx_audit_events_request_id_created_at"),
      `expected audit-events index; got ${indexNames.join(",")}`,
    );
    assert.ok(indexNames.includes("idx_signer_signing_states_source"));
  } finally {
    db.close();
    cleanup();
  }
});
