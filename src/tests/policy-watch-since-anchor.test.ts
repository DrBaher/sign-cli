import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSigningRequest,
  sendSigningRequest,
} from "../lib/signing-service.js";
import { runSignerPolicyWatch } from "../lib/policy-run-watch.js";
import type { PolicySpec } from "../lib/policy-engine.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-since-anchor-"));
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

function makePdf(dir: string): string {
  const p = path.join(dir, "doc.pdf");
  writeFileSync(p, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return p;
}

const SPEC: PolicySpec = { rules: [{ match: "any", action: "report" }] };

test("runSignerPolicyWatch sinceCreatedAt skips inbox entries created at/before the cutoff", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-since-anchor-flow-"));
    const documentPath = makePdf(dir);
    try {
      // The cutoff is "now" — any new request created after the watcher
      // starts has a createdAt > cutoff and should fire the hook. We make
      // the cutoff future-tense so EVERY new request is filtered out, then
      // confirm zero evaluations.
      const cutoff = new Date(Date.now() + 60_000).toISOString();

      let arrived: { requestId: string } | undefined;
      setTimeout(async () => {
        arrived = createSigningRequest(db, {
          title: "Arrived after watcher starts",
          documentPath,
          signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
          tokenTtlMinutes: 30,
          provider: "local",
          autoApprove: true,
        });
        await sendSigningRequest(db, { requestId: arrived.requestId, provider: "local", testMode: true });
      }, 25);

      const outcome = await runSignerPolicyWatch(db, {
        tokens: {},
        spec: SPEC,
        timeoutMs: 200,
        pollIntervalMs: 5000,
        sinceCreatedAt: cutoff,
      });
      // The new request landed in the inbox but its createdAt is < cutoff
      // (cutoff is 60s in the future), so the watcher MUST not have
      // evaluated it. Test passes when evaluated stays empty.
      assert.equal(outcome.evaluated.length, 0);
      assert.equal(outcome.skipped, 0);
      assert.equal(outcome.succeeded, 0);
      assert.equal(outcome.failed, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("runSignerPolicyWatch with a past cutoff lets every new entry through", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-since-anchor-pass-"));
    const documentPath = makePdf(dir);
    try {
      const past = new Date(Date.now() - 60_000).toISOString();
      let arrived: { requestId: string } | undefined;
      setTimeout(async () => {
        arrived = createSigningRequest(db, {
          title: "After past cutoff",
          documentPath,
          signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
          tokenTtlMinutes: 30,
          provider: "local",
          autoApprove: true,
        });
        await sendSigningRequest(db, { requestId: arrived.requestId, provider: "local", testMode: true });
      }, 25);

      const outcome = await runSignerPolicyWatch(db, {
        tokens: {},
        spec: SPEC,
        exitOnFirst: true,
        timeoutMs: 2000,
        sinceCreatedAt: past,
      });
      assert.equal(outcome.evaluated.length, 1);
      // No token on file → skipped, but the cutoff didn't filter it out.
      assert.equal(outcome.skipped, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
