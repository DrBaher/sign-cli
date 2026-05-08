import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db.js";
import {
  PostgresBackend,
  SqliteBackend,
  translatePlaceholders,
  wrapSqliteDb,
  type DbBackend,
  type PgQueryable,
} from "../lib/db-backend.js";
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

test("PostgresBackend.prepare/exec (sync) throw INTERNAL — pg is async-only, callers must use prepareAsync/execAsync", () => {
  const fakeClient = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  const backend = new PostgresBackend(fakeClient, "postgres://localhost/sign");
  assert.equal(backend.kind, "postgres");
  for (const fn of [() => backend.prepare("SELECT 1"), () => backend.exec("SELECT 1")]) {
    assert.throws(
      fn,
      (err: unknown) =>
        err instanceof SignCliError &&
        err.code === "INTERNAL" &&
        /async-only|prepareAsync|execAsync/.test(err.message),
    );
  }
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

test("openStorageBackend with backend=postgres returns a real pg-backed adapter (sync ops still throw)", async () => {
  const backend = openStorageBackend({ backend: "postgres", postgresUrl: "postgres://x:y@127.0.0.1:1/sign" });
  assert.equal(backend.kind, "postgres");
  // Sync surface: explicit "use prepareAsync" error.
  assert.throws(
    () => backend.prepare("SELECT 1"),
    (err: unknown) => err instanceof SignCliError && err.code === "INTERNAL",
  );
  // Async surface: builds a statement (lazy). We don't actually issue a query
  // since we have no Postgres listening; just confirm the statement exists.
  const stmt = backend.prepareAsync("SELECT $1::int AS n");
  assert.equal(typeof stmt.run, "function");
  assert.equal(typeof stmt.get, "function");
  assert.equal(typeof stmt.all, "function");
  await backend.close();
});

test("openStorageBackend with backend=postgres rejects when no connection string is provided", () => {
  const previous = process.env.SIGN_PG_URL;
  delete process.env.SIGN_PG_URL;
  try {
    assert.throws(
      () => openStorageBackend({ backend: "postgres" }),
      (err: unknown) => err instanceof SignCliError && err.code === "INVALID_ARGS" && /SIGN_PG_URL/.test(err.message),
    );
  } finally {
    if (previous !== undefined) process.env.SIGN_PG_URL = previous;
  }
});

test("translatePlaceholders rewrites ? to $1, $2 and skips literals containing ?", () => {
  assert.equal(translatePlaceholders("SELECT ? AS a, ? AS b"), "SELECT $1 AS a, $2 AS b");
  // Single-quoted literals are passed through unchanged, even if they contain ?.
  assert.equal(
    translatePlaceholders("SELECT * FROM t WHERE label = 'is this ok?' AND id = ?"),
    "SELECT * FROM t WHERE label = 'is this ok?' AND id = $1",
  );
  // Doubled '' inside a literal doesn't terminate it.
  assert.equal(
    translatePlaceholders("INSERT INTO t (s) VALUES ('it''s ?') RETURNING ?"),
    "INSERT INTO t (s) VALUES ('it''s ?') RETURNING $1",
  );
});

test("PostgresBackend.prepareAsync.run/get/all roundtrip through a fake pg client with translated placeholders", async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const fakeClient: PgQueryable = {
    async query(text, params) {
      calls.push({ text, params });
      // Emulate SELECT ... where the row is a Postgres row (plain object).
      return { rows: [{ n: 42 }], rowCount: 1 };
    },
  };
  const backend = new PostgresBackend(fakeClient);

  const runResult = await backend.prepareAsync("UPDATE t SET v = ? WHERE k = ?").run("v1", "k1");
  assert.equal(runResult.changes, 1);

  const getResult = await backend.prepareAsync("SELECT n FROM t WHERE k = ?").get("k2");
  assert.deepEqual(getResult, { n: 42 });

  const allResult = await backend.prepareAsync("SELECT n FROM t").all();
  assert.deepEqual(allResult, [{ n: 42 }]);

  // Each call's translated SQL has $1, $2, ... placeholders, not ?.
  assert.equal(calls[0].text, "UPDATE t SET v = $1 WHERE k = $2");
  assert.deepEqual(calls[0].params, ["v1", "k1"]);
  assert.equal(calls[1].text, "SELECT n FROM t WHERE k = $1");
  assert.equal(calls[2].text, "SELECT n FROM t");
});

test("SqliteBackend.prepareAsync wraps the sync API so callers can target the async interface", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-async-sqlite-"));
  const dbPath = path.join(dir, "x.db");
  try {
    const inner = openDatabase(dbPath);
    const backend = wrapSqliteDb(inner);
    backend.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    await backend.prepareAsync("INSERT INTO t (k, v) VALUES (?, ?)").run("hello", "world");
    const row = await backend.prepareAsync("SELECT v FROM t WHERE k = ?").get("hello");
    assert.deepEqual(row, { v: "world" });
    backend.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
