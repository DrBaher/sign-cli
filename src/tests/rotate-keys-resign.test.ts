import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSigningRequest,
  exportRequestReceipt,
  listAuditEvents,
  reSignAllReceipts,
} from "../lib/signing-service.js";
import { rotateLocalSignerKeys } from "../lib/local-keys.js";
import { verifyRequestReceiptBundle } from "../lib/receipt-verify.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

function withScopedKeyDir<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-resign-keys-"));
  const previous = process.env.SIGN_LOCAL_KEY_DIR;
  process.env.SIGN_LOCAL_KEY_DIR = dir;
  const restore = () => {
    if (previous === undefined) delete process.env.SIGN_LOCAL_KEY_DIR;
    else process.env.SIGN_LOCAL_KEY_DIR = previous;
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

test("reSignAllReceipts walks every receipt directory and rewrites manifest.sig + manifest.cert.pem with the live key", { concurrency: false }, async () => {
  await withScopedKeyDir(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("resign");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-resign-flow-"));
    try {
      const r = createSigningRequest(db, {
        title: "Resign", documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      const receiptDir = path.join(dir, "receipt");
      await exportRequestReceipt(db, { requestId: r.requestId, outDir: receiptDir });
      const oldCert = readFileSync(path.join(receiptDir, "manifest.cert.pem"), "utf8");
      const oldSig = readFileSync(path.join(receiptDir, "manifest.sig"));

      // Rotate the live key so the next signer is fresh.
      rotateLocalSignerKeys();

      const outcome = await reSignAllReceipts(db);
      assert.equal(outcome.total, 1);
      assert.equal(outcome.succeeded, 1);
      assert.equal(outcome.failed, 0);
      const newCert = readFileSync(path.join(receiptDir, "manifest.cert.pem"), "utf8");
      const newSig = readFileSync(path.join(receiptDir, "manifest.sig"));
      assert.notEqual(newCert, oldCert, "cert should change after re-sign");
      assert.notEqual(Buffer.compare(newSig, oldSig), 0, "signature should change after re-sign");

      // Receipt still verifies under the new key (re-uses the cert in the bundle).
      const verdict = verifyRequestReceiptBundle(receiptDir);
      assert.equal(verdict.ok, true);

      // Audit chain records the re-sign.
      const types = listAuditEvents(db, r.requestId).map((e) => e.event_type);
      assert.ok(types.includes("request.receipt_resigned"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("reSignAllReceipts reports a failure when a recorded receipt directory has been deleted, without aborting the batch", { concurrency: false }, async () => {
  await withScopedKeyDir(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("resign-missing");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-resign-missing-flow-"));
    try {
      const ok = createSigningRequest(db, {
        title: "OK", documentPath,
        signers: [{ name: "A", email: "a@x.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      const okDir = path.join(dir, "ok");
      await exportRequestReceipt(db, { requestId: ok.requestId, outDir: okDir });
      const gone = createSigningRequest(db, {
        title: "Gone", documentPath,
        signers: [{ name: "B", email: "b@x.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      const goneDir = path.join(dir, "gone");
      await exportRequestReceipt(db, { requestId: gone.requestId, outDir: goneDir });
      // Delete one receipt to simulate a moved/cleaned directory.
      rmSync(goneDir, { recursive: true, force: true });

      const outcome = await reSignAllReceipts(db);
      assert.equal(outcome.total, 2);
      assert.equal(outcome.succeeded, 1);
      assert.equal(outcome.failed, 1);
      const okRow = outcome.results.find((r) => r.requestId === ok.requestId)!;
      const goneRow = outcome.results.find((r) => r.requestId === gone.requestId)!;
      assert.equal(okRow.ok, true);
      assert.equal(goneRow.ok, false);
      assert.match(goneRow.error?.message ?? "", /manifest\.json missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
