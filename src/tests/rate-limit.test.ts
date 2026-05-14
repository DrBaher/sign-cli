import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSigningRequest,
  fetchUnsignedDocumentForSigner,
  sendSigningRequest,
} from "../lib/signing-service.js";
import { SignCliError } from "../lib/sign-error.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-rate-limit-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  const previousLimit = process.env.SIGN_LOCAL_MAX_FETCHES_PER_HOUR;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousAuto === undefined) delete process.env.SIGN_LOCAL_AUTOCOMPLETE;
    else process.env.SIGN_LOCAL_AUTOCOMPLETE = previousAuto;
    if (previousLimit === undefined) delete process.env.SIGN_LOCAL_MAX_FETCHES_PER_HOUR;
    else process.env.SIGN_LOCAL_MAX_FETCHES_PER_HOUR = previousLimit;
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

test("SIGN_LOCAL_MAX_FETCHES_PER_HOUR throttles repeated fetches with RATE_LIMITED", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    process.env.SIGN_LOCAL_MAX_FETCHES_PER_HOUR = "2";
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-rate-limit-doc-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Rate test",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const token = created.tokens[0].token;

      // Two fetches succeed.
      await fetchUnsignedDocumentForSigner(db, { requestId: created.requestId, token });
      await fetchUnsignedDocumentForSigner(db, { requestId: created.requestId, token });
      // Third hits the limit.
      await assert.rejects(
        () => fetchUnsignedDocumentForSigner(db, { requestId: created.requestId, token }),
        (err: unknown) => err instanceof SignCliError && err.code === "RATE_LIMITED",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("Without SIGN_LOCAL_MAX_FETCHES_PER_HOUR, fetches are unlimited", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    delete process.env.SIGN_LOCAL_MAX_FETCHES_PER_HOUR;
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-rate-limit-unlim-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Unlimited",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const token = created.tokens[0].token;
      // Many calls — none rate-limited.
      for (let i = 0; i < 5; i += 1) {
        fetchUnsignedDocumentForSigner(db, { requestId: created.requestId, token });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("Different request IDs count separately against the per-hour limit", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    process.env.SIGN_LOCAL_MAX_FETCHES_PER_HOUR = "1";
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-rate-limit-distinct-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const a = createSigningRequest(db, {
        title: "A",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      const b = createSigningRequest(db, {
        title: "B",
        documentPath,
        signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: a.requestId, provider: "local", testMode: true });
      await sendSigningRequest(db, { requestId: b.requestId, provider: "local", testMode: true });
      await fetchUnsignedDocumentForSigner(db, { requestId: a.requestId, token: a.tokens[0].token });
      await fetchUnsignedDocumentForSigner(db, { requestId: b.requestId, token: b.tokens[0].token });
      // Each is at its limit; another fetch on either should fail.
      await assert.rejects(
        () => fetchUnsignedDocumentForSigner(db, { requestId: a.requestId, token: a.tokens[0].token }),
        (err: unknown) => err instanceof SignCliError && err.code === "RATE_LIMITED",
      );
      await assert.rejects(
        () => fetchUnsignedDocumentForSigner(db, { requestId: b.requestId, token: b.tokens[0].token }),
        (err: unknown) => err instanceof SignCliError && err.code === "RATE_LIMITED",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("Fetches outside the 1-hour window don't count against the limit", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    process.env.SIGN_LOCAL_MAX_FETCHES_PER_HOUR = "1";
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-rate-limit-window-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Window",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 999,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const token = created.tokens[0].token;
      // Two fetches with simulated "now" 90 minutes apart — outside the window, so no rate-limit.
      const earlier = new Date(Date.now() - 90 * 60 * 1000);
      await fetchUnsignedDocumentForSigner(db, { requestId: created.requestId, token, now: earlier });
      // The second call uses the real "now"; the earlier event falls outside the window.
      await fetchUnsignedDocumentForSigner(db, { requestId: created.requestId, token });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
