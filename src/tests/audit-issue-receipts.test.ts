import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyRequestReceiptBundle } from "../lib/receipt-verify.js";
import {
  createSigningRequest,
  issueAuditReceiptsBulk,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-issue-receipts-"));
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

test("issueAuditReceiptsBulk produces one verifiable receipt per matching request", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-issue-receipts-flow-"));
    const documentPath = makeFixturePdf(dir);
    const outDir = path.join(dir, "receipts");
    try {
      // 3 requests; 2 completed, 1 still pending.
      const created: Array<{ id: string; status: "completed" | "sent" }> = [];
      for (let i = 0; i < 3; i += 1) {
        const c = createSigningRequest(db, {
          title: `Bulk ${i}`,
          documentPath,
          signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
          tokenTtlMinutes: 30,
          provider: "local",
          autoApprove: true,
        });
        await sendSigningRequest(db, { requestId: c.requestId, provider: "local", testMode: true });
        if (i < 2) {
          signSigningRequest(db, { requestId: c.requestId, token: c.tokens[0].token });
          created.push({ id: c.requestId, status: "completed" });
        } else {
          created.push({ id: c.requestId, status: "sent" });
        }
      }

      const result = await issueAuditReceiptsBulk(db, { outDir, status: "completed" });
      assert.equal(result.total, 2);
      assert.equal(result.succeeded, 2);
      assert.equal(result.failed, 0);
      for (const row of result.results) {
        assert.ok(row.outDir);
        assert.ok(existsSync(path.join(row.outDir!, "manifest.json")));
        const verdict = verifyRequestReceiptBundle(row.outDir!);
        assert.equal(verdict.ok, true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("issueAuditReceiptsBulk handles a row that can't be receipted without aborting the rest", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-issue-receipts-mixed-"));
    const documentPath = makeFixturePdf(dir);
    const outDir = path.join(dir, "receipts");
    try {
      const a = createSigningRequest(db, {
        title: "OK row",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: a.requestId, provider: "local", testMode: true });
      signSigningRequest(db, { requestId: a.requestId, token: a.tokens[0].token });

      // Force a "failing" row: mark completed but wipe its audit chain so receipt issuance has nothing to attest.
      const broken = createSigningRequest(db, {
        title: "Broken row",
        documentPath,
        signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      db.prepare("UPDATE requests SET status = 'completed' WHERE id = ?").run(broken.requestId);
      // Bypass the append-only trigger so we can simulate a corrupted/empty audit chain.
      db.exec("DROP TRIGGER IF EXISTS audit_events_no_delete");
      db.prepare("DELETE FROM audit_events WHERE request_id = ?").run(broken.requestId);

      const result = await issueAuditReceiptsBulk(db, { outDir, status: "completed" });
      assert.equal(result.total, 2);
      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 1);
      const okRow = result.results.find((r) => r.requestId === a.requestId)!;
      const brokenRow = result.results.find((r) => r.requestId === broken.requestId)!;
      assert.equal(okRow.ok, true);
      assert.equal(brokenRow.ok, false);
      assert.ok(brokenRow.error);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("issueAuditReceiptsBulk respects --provider and --status filters", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-issue-receipts-filter-"));
    const documentPath = makeFixturePdf(dir);
    const outDir = path.join(dir, "receipts");
    try {
      const c = createSigningRequest(db, {
        title: "Local one",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: c.requestId, provider: "local", testMode: true });
      signSigningRequest(db, { requestId: c.requestId, token: c.tokens[0].token });

      // A second request with provider=dropbox + status=completed shouldn't receive receipts under provider=local.
      createSigningRequest(db, {
        title: "Dropbox one",
        documentPath,
        signers: [{ name: "Carol", email: "carol@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "dropbox",
        autoApprove: true,
      });
      db.prepare("UPDATE requests SET status = 'completed' WHERE provider = 'dropbox'").run();

      const localOnly = await issueAuditReceiptsBulk(db, { outDir, provider: "local", status: "completed" });
      assert.equal(localOnly.total, 1);
      assert.equal(localOnly.results[0].title, "Local one");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
