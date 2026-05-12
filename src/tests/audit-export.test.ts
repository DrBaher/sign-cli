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

// --- Item 8: extended bundle artifacts -----------------------------------
// The bundle should be self-contained for downstream verifiers — original
// PDF, per-signer receipts, signature inspection report, and README.

test("Item 8: bundle includes original.pdf, README.md, and per-signer receipts; manifest captures sha256 for each", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("item-8-original");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "sign-bundle-v2-"));
  try {
    const created = createSigningRequest(db, {
      title: "Bundle v2",
      documentPath,
      signers: [
        { name: "Alice Adams", email: "alice@example.com", order: 1 },
        { name: "Bob Becker",  email: "bob@example.com",   order: 2 },
      ],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      autoApprove: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await exportAuditBundle(db, { requestId: created.requestId, outDir });
    const manifest = JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8"));

    assert.equal(manifest.bundleVersion, 2, "bundle should be marked v2");

    // 1. original.pdf — bytes match the source
    const originalEntry = result.files.find((f) => f.name === "original.pdf");
    assert.ok(originalEntry, "original.pdf must be in the bundle");
    assert.deepEqual(
      readFileSync(path.join(outDir, "original.pdf")),
      readFileSync(documentPath),
      "original.pdf bytes must match the source",
    );

    // 2. README.md exists, mentions key filenames, and is non-trivial
    const readmeEntry = result.files.find((f) => f.name === "README.md");
    assert.ok(readmeEntry, "README.md must be in the bundle");
    const readme = readFileSync(path.join(outDir, "README.md"), "utf8");
    assert.match(readme, /Audit Bundle for /);
    assert.match(readme, /verify-chain-bundle/);
    assert.match(readme, /receipts\/<email>\.json/);
    assert.match(readme, /signatures\.json/);
    // Bundle's own request id is in the README
    assert.ok(readme.includes(created.requestId));
    // Both signers are listed
    assert.match(readme, /alice@example\.com/);
    assert.match(readme, /bob@example\.com/);

    // 3. Per-signer receipts exist for both signers
    const aliceEntry = result.files.find((f) => f.name === "receipts/alice@example.com.json");
    const bobEntry   = result.files.find((f) => f.name === "receipts/bob@example.com.json");
    assert.ok(aliceEntry,  "receipts/alice@example.com.json must be present");
    assert.ok(bobEntry,    "receipts/bob@example.com.json must be present");

    const aliceReceipt = JSON.parse(readFileSync(path.join(outDir, "receipts/alice@example.com.json"), "utf8"));
    assert.equal(aliceReceipt.signer.email, "alice@example.com");
    assert.equal(aliceReceipt.signer.order, 1);
    assert.equal(aliceReceipt.documentHash.length, 64, "documentHash should be a sha256 hex string");
    assert.equal(aliceReceipt.requestId, created.requestId);
    assert.equal(aliceReceipt.chainValid, true);
    assert.ok(Array.isArray(aliceReceipt.events), "events must be an array");

    // Every event in Alice's receipt should reference her email — not Bob's
    for (const evt of aliceReceipt.events) {
      const payload = JSON.parse(evt.payload_json);
      assert.equal(payload.signerEmail, "alice@example.com",
        `Alice's receipt leaked an event for ${payload.signerEmail ?? "(unknown signer)"}`);
    }

    // 4. Every recorded file has a 64-hex sha256
    for (const f of result.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.name} should have a sha256 hex`);
      assert.ok(f.bytes > 0, `${f.name} should be non-empty`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("Item 8: per-signer receipts isolate events — Bob's receipt does not leak Alice's events", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("item-8-isolation");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "sign-bundle-isolation-"));
  try {
    const created = createSigningRequest(db, {
      title: "Isolation",
      documentPath,
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob",   email: "bob@example.com",   order: 2 },
      ],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      autoApprove: true,
    });
    await exportAuditBundle(db, { requestId: created.requestId, outDir });

    const bobReceipt = JSON.parse(readFileSync(path.join(outDir, "receipts/bob@example.com.json"), "utf8"));
    for (const evt of bobReceipt.events) {
      const payload = JSON.parse(evt.payload_json);
      assert.notEqual(payload.signerEmail, "alice@example.com",
        "Bob's receipt must NOT contain Alice's events");
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("Item 8: signatures.json is present when signed.pdf exists; absent (no entry) otherwise — but README and original.pdf always present", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("item-8-nosig");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "sign-bundle-nosig-"));
  try {
    const created = createSigningRequest(db, {
      title: "No signed PDF",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
    });
    const result = await exportAuditBundle(db, { requestId: created.requestId, outDir });
    // No signed.pdf in this flow (request not approved/signed), so no
    // signatures.json should be in the manifest either.
    assert.equal(result.files.find((f) => f.name === "signed.pdf"), undefined);
    assert.equal(result.files.find((f) => f.name === "signatures.json"), undefined);
    // But README + original.pdf are unconditional.
    assert.ok(result.files.find((f) => f.name === "README.md"));
    assert.ok(result.files.find((f) => f.name === "original.pdf"));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("Item 8: bundle remains usable by request verify-receipt — manifest.json is still the trusted manifest", async () => {
  // Regression: extending the bundle shouldn't break exportRequestReceipt,
  // which signs manifest.json and produces manifest.sig + manifest.cert.pem.
  // verifyRequestReceiptBundle then validates that signature.
  const { exportRequestReceipt } = await import("../lib/signing-service.js");
  const { verifyRequestReceiptBundle } = await import("../lib/receipt-verify.js");
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("item-8-receipt");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "sign-bundle-receipt-"));
  try {
    const created = createSigningRequest(db, {
      title: "Receipt sign",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "dropbox",
      autoApprove: true,
    });
    await exportRequestReceipt(db, { requestId: created.requestId, outDir });
    const verified = verifyRequestReceiptBundle(outDir);
    assert.equal(verified.ok, true, "receipt should still verify with the v2 bundle");
    assert.equal(verified.manifestVerified, true);
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
