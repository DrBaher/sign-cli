import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bulkReissueSignerTokens,
  createSigningRequest,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-bulk-resend-"));
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

test("bulkReissueSignerTokens re-issues a fresh token for each valid row", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-bulk-resend-flow-"));
    const documentPath = makePdf(dir);
    try {
      const a = createSigningRequest(db, {
        title: "A", documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "local", autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: a.requestId, provider: "local", testMode: true });
      const b = createSigningRequest(db, {
        title: "B", documentPath,
        signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "local", autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: b.requestId, provider: "local", testMode: true });

      const result = bulkReissueSignerTokens(db, {
        rows: [
          { requestId: a.requestId, signerEmail: "alice@example.com" },
          { requestId: b.requestId, signerEmail: "bob@example.com" },
        ],
        tokenTtlMinutes: 60,
      });
      assert.equal(result.total, 2);
      assert.equal(result.succeeded, 2);
      assert.equal(result.failed, 0);
      for (const row of result.results) {
        assert.ok(row.token);
        assert.ok(row.tokenHint);
        assert.ok(row.expiresAt);
      }
      // Tokens are unique per row.
      assert.notEqual(result.results[0].token, result.results[1].token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("bulkReissueSignerTokens captures per-row failures without aborting", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-bulk-resend-mix-"));
    const documentPath = makePdf(dir);
    try {
      const ok = createSigningRequest(db, {
        title: "OK", documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "local", autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: ok.requestId, provider: "local", testMode: true });
      const signed = createSigningRequest(db, {
        title: "Signed", documentPath,
        signers: [{ name: "Carol", email: "carol@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "local", autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: signed.requestId, provider: "local", testMode: true });
      // Carol signs — re-issue should now refuse.
      signSigningRequest(db, { requestId: signed.requestId, token: signed.tokens[0].token });

      const result = bulkReissueSignerTokens(db, {
        rows: [
          { requestId: ok.requestId, signerEmail: "alice@example.com" },                    // OK
          { requestId: ok.requestId, signerEmail: "stranger@example.com" },                  // SIGNER_NOT_RECIPIENT
          { requestId: signed.requestId, signerEmail: "carol@example.com" },                 // SIGNER_ALREADY_SIGNED
          { requestId: "", signerEmail: "x@y.com" },                                          // INVALID_ARGS
        ],
      });
      assert.equal(result.total, 4);
      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 3);
      const codes = result.results.filter((r) => !r.ok).map((r) => r.error?.code);
      assert.ok(codes.includes("SIGNER_NOT_RECIPIENT"));
      assert.ok(codes.includes("SIGNER_ALREADY_SIGNED"));
      assert.ok(codes.includes("INVALID_ARGS"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
