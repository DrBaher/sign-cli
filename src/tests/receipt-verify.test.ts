import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSigningRequest,
  exportRequestReceipt,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { verifyRequestReceiptBundle } from "../lib/receipt-verify.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-receipt-verify-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousKeys = process.env.SIGN_LOCAL_KEY_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_KEY_DIR = path.join(dir, "keys");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousKeys === undefined) delete process.env.SIGN_LOCAL_KEY_DIR;
    else process.env.SIGN_LOCAL_KEY_DIR = previousKeys;
    if (previousAuto === undefined) delete process.env.SIGN_LOCAL_AUTOCOMPLETE;
    else process.env.SIGN_LOCAL_AUTOCOMPLETE = previousAuto;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return documentPath;
}

async function bootstrapReceipt(): Promise<{ outDir: string; cleanup: () => void }> {
  const { dbPath, cleanup: dbCleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-receipt-fixture-"));
  const documentPath = makeFixturePdf(dir);
  const outDir = path.join(dir, "receipt");
  const created = createSigningRequest(db, {
    title: "Verify receipt",
    documentPath,
    signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    tokenTtlMinutes: 30,
    provider: "local",
    autoApprove: true,
  });
  await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
  signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });
  await exportRequestReceipt(db, { requestId: created.requestId, outDir });
  db.close();
  return {
    outDir,
    cleanup: () => {
      dbCleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("verifyRequestReceiptBundle accepts a freshly-produced bundle", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { outDir, cleanup } = await bootstrapReceipt();
    try {
      const result = verifyRequestReceiptBundle(outDir);
      assert.equal(result.ok, true, `verifier should pass; errors=${JSON.stringify(result.errors)}`);
      assert.equal(result.manifestVerified, true);
      assert.match(result.signerSubject ?? "", /Sign CLI/);
      assert.ok(result.files.length > 0);
      assert.ok(result.files.every((f) => f.ok));
      assert.equal(result.chain?.ok, true);
    } finally {
      cleanup();
    }
  });
});

test("verifyRequestReceiptBundle detects a tampered manifest", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { outDir, cleanup } = await bootstrapReceipt();
    try {
      const manifestPath = path.join(outDir, "manifest.json");
      const original = readFileSync(manifestPath);
      writeFileSync(manifestPath, Buffer.concat([original, Buffer.from(" /* tampered */", "utf8")]));
      const result = verifyRequestReceiptBundle(outDir);
      assert.equal(result.ok, false);
      assert.equal(result.manifestVerified, false);
      assert.ok(result.errors.some((msg) => /Signature does not verify/.test(msg)));
    } finally {
      cleanup();
    }
  });
});

test("verifyRequestReceiptBundle detects a tampered bundle file (signed.pdf or audit.json)", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { outDir, cleanup } = await bootstrapReceipt();
    try {
      const auditPath = path.join(outDir, "audit.json");
      const original = readFileSync(auditPath, "utf8");
      writeFileSync(auditPath, original.replace(/"events"/, '"tampered_events"'));
      const result = verifyRequestReceiptBundle(outDir);
      assert.equal(result.ok, false);
      // Manifest hash check covers audit.json too — file SHA256 mismatch wins.
      const auditCheck = result.files.find((f) => f.name === "audit.json");
      assert.ok(auditCheck);
      assert.equal(auditCheck!.ok, false);
    } finally {
      cleanup();
    }
  });
});

test("verifyRequestReceiptBundle reports missing files individually", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-receipt-empty-"));
  try {
    const result = verifyRequestReceiptBundle(dir);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /missing one or more of/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyRequestReceiptBundle reports a non-existent directory cleanly", () => {
  const result = verifyRequestReceiptBundle("/this/path/does/not/exist-xyz123");
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((msg) => /does not exist/.test(msg)));
});
