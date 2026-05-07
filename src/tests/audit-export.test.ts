import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSigningRequest, exportAuditBundle, inspectRequestSignedPdf } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("exportAuditBundle produces audit.json + manifest.json with sha256 entries", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("audit-export");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-out-"));
  try {
    const created = createSigningRequest(db, {
      title: "Export bundle",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await exportAuditBundle(db, { requestId: created.requestId, outDir });
    assert.equal(result.chain.valid, true);
    const manifest = JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.requestId, created.requestId);
    assert.equal(manifest.chainValid, true);
    const auditFile = result.files.find((f) => f.name === "audit.json");
    assert.ok(auditFile);
    assert.ok(auditFile!.sha256.length === 64);

    const audit = JSON.parse(readFileSync(path.join(outDir, "audit.json"), "utf8"));
    assert.equal(audit.request.id, created.requestId);
    assert.ok(Array.isArray(audit.events));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("inspectRequestSignedPdf accepts an explicit --path and audits the inspection", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("inspect");
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-inspect-"));
  const fakePdf = path.join(dir, "fake.pdf");
  writeFileSync(fakePdf, "%PDF-1.4\n%nothing\n%%EOF");
  try {
    const created = createSigningRequest(db, {
      title: "Inspect",
      documentPath,
      signers: [{ name: "A", email: "a@b.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      now: new Date(),
    });
    const { source, report } = await inspectRequestSignedPdf(db, { requestId: created.requestId, path: fakePdf });
    assert.equal(source, "path");
    assert.equal(report.hasSignature, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});
