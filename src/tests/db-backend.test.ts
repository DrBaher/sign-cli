import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db.js";
import { PostgresBackend, SqliteBackend, wrapSqliteDb, type DbBackend } from "../lib/db-backend.js";
import { openStorageBackend } from "../lib/storage.js";
import { SignCliError } from "../lib/sign-error.js";

function withTempSqlite<T>(fn: (db: DbBackend, dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-dbbackend-"));
  const dbPath = path.join(dir, "test.db");
  const inner = openDatabase(dbPath);
  const backend = wrapSqliteDb(inner);
  try {
    return fn(backend, dir);
  } finally {
    backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("SqliteBackend.prepare exposes run/get/all that round-trip a row", () => {
  withTempSqlite((backend) => {
    backend.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const insert = backend.prepare("INSERT INTO kv (k, v) VALUES (?, ?)");
    const result = insert.run("hello", "world");
    assert.equal(result.changes, 1);
    const row = backend.prepare("SELECT v FROM kv WHERE k = ?").get("hello");
    assert.deepEqual(row, { v: "world" });
    const all = backend.prepare("SELECT k FROM kv").all();
    assert.deepEqual(all, [{ k: "hello" }]);
  });
});

test("SqliteBackend.kind identifies the engine for callers that branch on backend", () => {
  withTempSqlite((backend) => {
    assert.equal(backend.kind, "sqlite");
    assert.ok(backend instanceof SqliteBackend);
  });
});

test("PostgresBackend.prepare/exec throw INTERNAL with a pointer to MIGRATION.md", () => {
  const backend = new PostgresBackend("postgres://localhost/sign");
  assert.equal(backend.kind, "postgres");
  for (const fn of [() => backend.prepare("SELECT 1"), () => backend.exec("SELECT 1")]) {
    assert.throws(
      fn,
      (err: unknown) =>
        err instanceof SignCliError &&
        err.code === "INTERNAL" &&
        err.message.includes("MIGRATION.md"),
    );
  }
  // close() is a no-op on the stub — must not throw.
  backend.close();
});

test("openStorageBackend with backend=sqlite returns a usable DbBackend", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-storage-be-"));
  const dbPath = path.join(dir, "sign.db");
  try {
    const backend = openStorageBackend({ backend: "sqlite", dbPath });
    assert.equal(backend.kind, "sqlite");
    const row = backend.prepare("SELECT 1 AS n").get();
    assert.deepEqual(row, { n: 1 });
    backend.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStorageBackend with backend=postgres returns a stub adapter that throws on use", () => {
  const backend = openStorageBackend({ backend: "postgres", postgresUrl: "postgres://x/y" });
  assert.equal(backend.kind, "postgres");
  assert.throws(
    () => backend.prepare("SELECT 1"),
    (err: unknown) => err instanceof SignCliError && err.code === "INTERNAL",
  );
});
