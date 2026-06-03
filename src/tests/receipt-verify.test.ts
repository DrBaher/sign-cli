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

test("verifyRequestReceiptBundle refuses traversal/absolute file names in the manifest (no crash, marked failed)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-receipt-traversal-"));
  try {
    // A hostile manifest pointing at /etc/passwd and ../../secret, plus a
    // non-string name. None of these should be read; verification must fail
    // cleanly rather than throwing or following the paths.
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      requestId: "x",
      files: [
        { name: "/etc/passwd", sha256: "0".repeat(64), bytes: 1 },
        { name: "../../escape.txt", sha256: "0".repeat(64), bytes: 1 },
        { name: 42 as unknown as string, sha256: "0".repeat(64), bytes: 1 },
      ],
    }));
    writeFileSync(path.join(dir, "manifest.sig"), Buffer.alloc(8));
    writeFileSync(path.join(dir, "manifest.cert.pem"), "not a cert");
    const result = verifyRequestReceiptBundle(dir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((m) => /escapes the bundle directory/.test(m)), "absolute path must be refused");
    assert.ok(result.errors.some((m) => /non-string `name`/.test(m)), "non-string name must be flagged, not crash");
    // The /etc/passwd contents must NOT have been read into any check.
    assert.ok(result.files.every((f) => f.actual === ""), "no escaping file should have been hashed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyRequestReceiptBundle: --expect-fingerprint pins the signer; non-pinned ok carries a trust caveat", async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const outDir = mkdtempSync(path.join(os.tmpdir(), "sign-receipt-pin-"));
    try {
      const created = createSigningRequest(db, {
        title: "Pin test",
        documentPath: makeFixturePdf(outDir),
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const token = created.tokens.find((t) => t.signer.email === "alice@example.com")!.token;
      signSigningRequest(db, { requestId: created.requestId, token });
      const bundle = await exportRequestReceipt(db, { requestId: created.requestId, outDir: path.join(outDir, "receipt") });

      const unpinned = verifyRequestReceiptBundle(bundle.outDir);
      assert.equal(unpinned.fingerprintPinned, null);
      assert.match(unpinned.trustNote, /internal consistency only/i);
      assert.ok(unpinned.signerFingerprintSha256, "embedded cert fingerprint must be reported");

      const pinnedOk = verifyRequestReceiptBundle(bundle.outDir, { expectFingerprintSha256: unpinned.signerFingerprintSha256! });
      assert.equal(pinnedOk.fingerprintPinned, true);
      assert.equal(pinnedOk.ok, unpinned.ok);

      const pinnedBad = verifyRequestReceiptBundle(bundle.outDir, { expectFingerprintSha256: "ab".repeat(32) });
      assert.equal(pinnedBad.fingerprintPinned, false);
      assert.equal(pinnedBad.ok, false, "a fingerprint mismatch must fail verification");
    } finally {
      db.close();
      cleanup();
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
