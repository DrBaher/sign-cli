import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bulkSendFromCsv, runSignerPolicyAll } from "../lib/signing-service.js";
import { parsePolicySpec } from "../lib/policy-engine.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-bulk-tokens-"));
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

test("bulkSendFromCsv emits per-row tokens for local provider", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-bulk-tokens-doc-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const result = await bulkSendFromCsv(db, {
        rows: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Bob", email: "bob@example.com" },
        ],
        titleTemplate: "Bulk for {{email}}",
        documentPaths: [documentPath],
        provider: "local",
        testMode: true,
      });
      assert.equal(result.succeeded, 2);
      assert.equal(result.failed, 0);
      for (const row of result.results) {
        assert.equal(row.ok, true);
        assert.ok(row.token, `row ${row.row} should have a token`);
        assert.match(row.tokenExpiresAt ?? "", /T/);
      }
      // Tokens are unique across rows.
      const tokens = new Set(result.results.map((r) => r.token));
      assert.equal(tokens.size, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("bulkSendFromCsv tokens are usable by signer policy run-all", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-bulk-tokens-policy-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const result = await bulkSendFromCsv(db, {
        rows: [
          { name: "Alice", email: "alice@example.com" },
          { name: "Bob", email: "bob@example.com" },
        ],
        titleTemplate: "Bulk for {{email}}",
        documentPaths: [documentPath],
        provider: "local",
        testMode: true,
      });
      // Build the tokens map the way `--emit-tokens` would write it.
      const tokens: Record<string, string> = {};
      for (const r of result.results) {
        if (r.requestId && r.token) tokens[r.requestId] = r.token;
      }

      const spec = parsePolicySpec({ rules: [{ match: "any", action: "sign" }] });
      // run-all is signer-scoped; first do alice, then bob, to exercise both rows.
      const aliceOutcome = runSignerPolicyAll(db, { signerEmail: "alice@example.com", tokens, spec });
      assert.equal(aliceOutcome.succeeded, 1);
      assert.equal(aliceOutcome.failed, 0);
      const bobOutcome = runSignerPolicyAll(db, { signerEmail: "bob@example.com", tokens, spec });
      assert.equal(bobOutcome.succeeded, 1);
      assert.equal(bobOutcome.failed, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("bulkSendFromCsv records null token on rows that fail validation", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-bulk-tokens-bad-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const result = await bulkSendFromCsv(db, {
        rows: [
          { name: "Alice", email: "alice@example.com" },
          { name: "", email: "noname@example.com" },
        ],
        titleTemplate: "Bulk for {{email}}",
        documentPaths: [documentPath],
        provider: "local",
        testMode: true,
      });
      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 1);
      const failed = result.results.find((r) => !r.ok)!;
      assert.equal(failed.token, null);
      assert.equal(failed.tokenExpiresAt, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
