import test from "node:test";
import assert from "node:assert/strict";
import { describeBackend, openStorage, resolveBackend, SUPPORTED_BACKENDS } from "../lib/storage.js";
import { SignCliError } from "../lib/sign-error.js";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("resolveBackend defaults to sqlite", () => {
  const previous = process.env.SIGN_DB_BACKEND;
  delete process.env.SIGN_DB_BACKEND;
  try {
    assert.equal(resolveBackend(), "sqlite");
  } finally {
    if (previous !== undefined) process.env.SIGN_DB_BACKEND = previous;
  }
});

test("resolveBackend honours SIGN_DB_BACKEND and explicit overrides", () => {
  const previous = process.env.SIGN_DB_BACKEND;
  process.env.SIGN_DB_BACKEND = "postgres";
  try {
    assert.equal(resolveBackend(), "postgres");
    assert.equal(resolveBackend("sqlite"), "sqlite");
  } finally {
    if (previous === undefined) delete process.env.SIGN_DB_BACKEND;
    else process.env.SIGN_DB_BACKEND = previous;
  }
});

test("resolveBackend rejects unsupported backends with INVALID_ARGS", () => {
  assert.throws(
    () => resolveBackend("redis"),
    (err: unknown) => err instanceof SignCliError && err.code === "INVALID_ARGS",
  );
});

test("describeBackend marks sqlite ready and postgres not-yet-implemented", () => {
  const sqlite = describeBackend("sqlite");
  assert.equal(sqlite.backend, "sqlite");
  assert.equal(sqlite.ready, true);
  const postgres = describeBackend("postgres");
  assert.equal(postgres.backend, "postgres");
  assert.equal(postgres.ready, false);
  assert.match(postgres.notes ?? "", /MIGRATION\.md/);
});

test("openStorage with backend=sqlite returns a usable DatabaseSync", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-storage-"));
  const dbPath = path.join(dir, "sign.db");
  try {
    const db = openStorage({ backend: "sqlite", dbPath });
    const row = db.prepare("SELECT 1 AS n").get() as { n: number };
    assert.equal(row.n, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStorage with backend=postgres throws INTERNAL with the migration pointer", () => {
  assert.throws(
    () => openStorage({ backend: "postgres" }),
    (err: unknown) =>
      err instanceof SignCliError &&
      err.code === "INTERNAL" &&
      err.message.includes("MIGRATION.md"),
  );
});

test("SUPPORTED_BACKENDS exposes the sqlite + postgres set", () => {
  assert.deepEqual([...SUPPORTED_BACKENDS].sort(), ["postgres", "sqlite"]);
});
