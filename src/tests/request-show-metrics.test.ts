import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSigningRequest,
  fetchUnsignedDocumentForSigner,
  getRequestSnapshot,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-show-metrics-"));
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

test("getRequestSnapshot omits the metrics block by default", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-metrics-noflag-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "No metrics",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      const snap = getRequestSnapshot(db, created.requestId);
      assert.equal((snap as { metrics?: unknown }).metrics, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("getRequestSnapshot --metrics reports counters and time-to-first-sign / time-to-complete", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-metrics-flow-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "With metrics",
        documentPath,
        signers: [
          { name: "Alice", email: "alice@example.com", order: 1 },
          { name: "Bob", email: "bob@example.com", order: 2 },
        ],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const aliceToken = created.tokens.find((t) => t.signer.email === "alice@example.com")!.token;
      const bobToken = created.tokens.find((t) => t.signer.email === "bob@example.com")!.token;
      // Two fetches and a sign — this exercises fetches_last_hour + signed_count counters.
      fetchUnsignedDocumentForSigner(db, { requestId: created.requestId, token: aliceToken });
      fetchUnsignedDocumentForSigner(db, { requestId: created.requestId, token: aliceToken });
      signSigningRequest(db, { requestId: created.requestId, token: aliceToken });
      signSigningRequest(db, { requestId: created.requestId, token: bobToken });

      const snap = getRequestSnapshot(db, created.requestId, { includeMetrics: true });
      assert.ok(snap.metrics);
      const m = snap.metrics!;
      assert.equal(m.totalSigners, 2);
      assert.equal(m.signedCount, 2);
      assert.equal(m.pendingCount, 0);
      assert.equal(m.declined, false);
      assert.ok(m.eventsTotal >= 5);
      assert.equal(m.fetchesLastHour, 2);
      assert.equal(m.webhookReplaysLastHour, 0);
      assert.equal(typeof m.ageSeconds, "number");
      assert.equal(typeof m.timeToFirstSignSeconds, "number");
      assert.equal(typeof m.timeToCompleteSeconds, "number");
      assert.ok(m.timeToCompleteSeconds! >= m.timeToFirstSignSeconds!);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("getRequestSnapshot --metrics has null timeToFirstSign on a request with no signatures yet", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-metrics-pending-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Pending",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const snap = getRequestSnapshot(db, created.requestId, { includeMetrics: true });
      assert.equal(snap.metrics?.signedCount, 0);
      assert.equal(snap.metrics?.timeToFirstSignSeconds, null);
      assert.equal(snap.metrics?.timeToCompleteSeconds, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
