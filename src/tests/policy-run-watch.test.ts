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
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-pol-watch-"));
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

const REPORT_ALL_SPEC: PolicySpec = {
  rules: [{ match: "any", action: "report" }],
};

test("runSignerPolicyWatch evaluates only NEW entries (initial snapshot is informational)", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-pol-watch-flow-"));
    const documentPath = makePdf(dir);
    try {
      // Pre-existing request — counted as initial snapshot, not evaluated.
      const initial = createSigningRequest(db, {
        title: "Initial",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: initial.requestId, provider: "local", testMode: true });

      // Schedule a NEW request to appear after a short delay so the watcher catches it.
      let newRequest: { requestId: string; tokens: { token: string }[] } | undefined;
      setTimeout(async () => {
        newRequest = createSigningRequest(db, {
          title: "Newly arrived",
          documentPath,
          signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
          tokenTtlMinutes: 30,
          provider: "local",
          autoApprove: true,
        });
        await sendSigningRequest(db, { requestId: newRequest.requestId, provider: "local", testMode: true });
      }, 25);

      const outcome = await runSignerPolicyWatch(db, {
        tokens: {}, // empty — every new entry hits the "skipped" path
        spec: REPORT_ALL_SPEC,
        exitOnFirst: true,
        timeoutMs: 2000,
      });
      // Initial entries are NOT in evaluated.
      assert.equal(outcome.evaluated.length, 1);
      const e = outcome.evaluated[0];
      assert.equal(e.requestId, newRequest!.requestId);
      assert.equal(e.skipped, true); // no token on file
      assert.equal(e.ok, false);
      assert.equal(outcome.skipped, 1);
      assert.equal(outcome.succeeded, 0);
      assert.equal(outcome.failed, 0);
      assert.equal(outcome.watch.exitReason, "exit_on_first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("runSignerPolicyWatch runs the policy when a token is on file (dry-run)", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-pol-watch-token-"));
    const documentPath = makePdf(dir);
    try {
      let arrived: { requestId: string; tokens: { token: string }[] } | undefined;
      let tokens: Record<string, string> = {};
      setTimeout(async () => {
        arrived = createSigningRequest(db, {
          title: "Will-be-evaluated",
          documentPath,
          signers: [{ name: "Carol", email: "carol@example.com", order: 1 }],
          tokenTtlMinutes: 30,
          provider: "local",
          autoApprove: true,
        });
        // Populate the token map BEFORE send so the inbox-notification path
        // sees a fully-populated tokens map at evaluation time.
        tokens[arrived.requestId] = arrived.tokens[0].token;
        await sendSigningRequest(db, { requestId: arrived.requestId, provider: "local", testMode: true });
      }, 25);

      const outcome = await runSignerPolicyWatch(db, {
        // Pass a Proxy so the live `tokens` map is consulted at evaluation time.
        tokens: new Proxy({} as Record<string, string>, {
          get(_target, prop) { return typeof prop === "string" ? tokens[prop] : undefined; },
          has(_target, prop) { return typeof prop === "string" && prop in tokens; },
        }),
        spec: REPORT_ALL_SPEC,
        exitOnFirst: true,
        dryRun: true,
        timeoutMs: 2000,
      });
      assert.equal(outcome.evaluated.length, 1);
      assert.equal(outcome.skipped, 0);
      assert.equal(outcome.succeeded, 1);
      assert.equal(outcome.evaluated[0].decision?.action, "report");
      assert.equal(outcome.evaluated[0].applied, false); // dry-run
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
