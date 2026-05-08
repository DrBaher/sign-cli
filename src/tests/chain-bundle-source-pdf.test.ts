import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportAuditChainBundle } from "../lib/audit-chain-bundle.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("exportAuditChainBundle --include-source-pdf copies the source PDF into each per-request receipt dir", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("source-pdf");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-source-pdf-"));
  try {
    const r = createSigningRequest(db, {
      title: "With source",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const out = path.join(dir, "bundle");
    const report = await exportAuditChainBundle(db, { outDir: out, includeSourcePdf: true });
    const sourcePath = path.join(report.requests[0].receiptDir, "source.pdf");
    assert.ok(existsSync(sourcePath), "source.pdf should exist in the per-request dir");
    // Bytes should match the original.
    assert.deepEqual(readFileSync(sourcePath), readFileSync(documentPath));
    void r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("exportAuditChainBundle without --include-source-pdf does not write source.pdf", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("source-pdf-default");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-source-pdf-default-"));
  try {
    createSigningRequest(db, {
      title: "Default", documentPath,
      signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
    });
    const out = path.join(dir, "bundle");
    const report = await exportAuditChainBundle(db, { outDir: out });
    assert.equal(existsSync(path.join(report.requests[0].receiptDir, "source.pdf")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("exportAuditChainBundle --include-source-pdf silently skips a request whose source PDF has been deleted", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("source-pdf-missing");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-source-pdf-missing-"));
  try {
    const r = createSigningRequest(db, {
      title: "Missing source", documentPath,
      signers: [{ name: "Carol", email: "carol@example.com", order: 1 }],
      tokenTtlMinutes: 30, provider: "dropbox",
    });
    // Repoint document_path at a nonexistent file.
    db.prepare("UPDATE requests SET document_path = ? WHERE id = ?")
      .run("/tmp/this-file-does-not-exist.pdf", r.requestId);
    const out = path.join(dir, "bundle");
    const report = await exportAuditChainBundle(db, { outDir: out, includeSourcePdf: true });
    // No source.pdf written, but the rest of the bundle still came together.
    assert.equal(existsSync(path.join(report.requests[0].receiptDir, "source.pdf")), false);
    assert.equal(report.requests.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});
