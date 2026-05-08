import test from "node:test";
import assert from "node:assert/strict";
import { verifyAuditChain } from "../lib/audit.js";
import { wrapSqliteDb, isDbBackend, asBackend } from "../lib/db-backend.js";
import { createSigningRequest, listAuditEvents } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("verifyAuditChain accepts a DbBackend wrapper and returns the same result as the SqliteDb path", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("dbb-verify");
  try {
    const created = createSigningRequest(db, {
      title: "DbBackend audit",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const viaSqlite = verifyAuditChain(db, created.requestId);
    const viaBackend = verifyAuditChain(wrapSqliteDb(db), created.requestId);
    assert.deepEqual(viaSqlite, viaBackend);
    assert.equal(viaSqlite.valid, true);
    assert.ok(viaSqlite.events > 0);
  } finally {
    db.close();
    cleanup();
  }
});

test("listAuditEvents accepts a DbBackend wrapper and returns identical rows", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("dbb-list");
  try {
    const created = createSigningRequest(db, {
      title: "DbBackend list",
      documentPath,
      signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const viaSqlite = listAuditEvents(db, created.requestId);
    const viaBackend = listAuditEvents(wrapSqliteDb(db), created.requestId);
    assert.deepEqual(viaSqlite, viaBackend);
    assert.ok(viaSqlite.length > 0);
  } finally {
    db.close();
    cleanup();
  }
});

test("isDbBackend / asBackend correctly distinguish SqliteDb from DbBackend", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    assert.equal(isDbBackend(db), false, "raw SqliteDb is not a DbBackend");
    const wrapped = wrapSqliteDb(db);
    assert.equal(isDbBackend(wrapped), true, "wrapped backend is a DbBackend");
    // asBackend is idempotent
    assert.equal(asBackend(wrapped), wrapped);
  } finally {
    db.close();
    cleanup();
  }
});
