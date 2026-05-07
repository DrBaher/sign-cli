import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupDatabase, verifyDatabase } from "../lib/db-admin.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("backupDatabase writes a valid copy", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("backup");
  const dest = mkdtempSync(path.join(os.tmpdir(), "sign-backup-"));
  const out = path.join(dest, "snap.db");
  try {
    createSigningRequest(db, {
      title: "Backup",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      now: new Date(),
    });
    const result = backupDatabase(db, dbPath, out);
    assert.ok(existsSync(out));
    assert.ok(result.bytes > 0);
  } finally {
    rmSync(dest, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("verifyDatabase returns ok for a clean DB", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = verifyDatabase(db);
    assert.equal(result.ok, true);
    assert.deepEqual(result.integrity, ["ok"]);
    assert.deepEqual(result.foreignKeys, []);
  } finally {
    db.close();
    cleanup();
  }
});
