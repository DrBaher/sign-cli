import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAuditWatch } from "../lib/audit-watch.js";
import { withAuditTamperingAllowed } from "../lib/db.js";
import { _resetResourceWatchersForTests } from "../lib/resource-watch.js";
import {
  createSigningRequest,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-watch-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
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

test("runAuditWatch exits with break_detected on the initial scan when the chain is already tampered", { concurrency: false }, async () => {
  _resetResourceWatchersForTests();
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-watch-tamper-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Tamper",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      withAuditTamperingAllowed(db, () => {
        db.prepare("UPDATE audit_events SET payload_json = ? WHERE request_id = ?").run("{}", created.requestId);
      });
      const outcome = await runAuditWatch(db, { pollIntervalMs: 50, timeoutMs: 200 });
      assert.equal(outcome.exitReason, "break_detected");
      assert.ok(outcome.firstBreak);
      assert.equal(outcome.firstBreak?.requestId, created.requestId);
      assert.equal(outcome.firstBreak?.valid, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("runAuditWatch reports timeout when the chain stays clean", { concurrency: false }, async () => {
  _resetResourceWatchersForTests();
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-watch-clean-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Clean",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const outcome = await runAuditWatch(db, { pollIntervalMs: 25, timeoutMs: 120 });
      assert.equal(outcome.exitReason, "timeout");
      assert.equal(outcome.firstBreak, null);
      assert.ok(outcome.scans >= 2, `expected scans >= 2; got ${outcome.scans}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("runAuditWatch detects mid-flight tamper triggered by a notification", { concurrency: false }, async () => {
  _resetResourceWatchersForTests();
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-watch-mid-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Mid",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });

      // Tamper after the watch has started, forcing the next scan to flag it.
      const watchPromise = runAuditWatch(db, { pollIntervalMs: 30, timeoutMs: 800 });
      setTimeout(() => {
        // Append a fresh event (triggers notify) AND tamper before the scan reads.
        signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });
        withAuditTamperingAllowed(db, () => {
          db.prepare("UPDATE audit_events SET payload_json = ? WHERE request_id = ?").run("{\"hacked\":true}", created.requestId);
        });
      }, 50);
      const outcome = await watchPromise;
      assert.equal(outcome.exitReason, "break_detected");
      assert.equal(outcome.firstBreak?.valid, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
