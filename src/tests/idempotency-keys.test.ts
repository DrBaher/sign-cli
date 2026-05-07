import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSigningRequest,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-idempotency-keys-"));
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

test("createSigningRequest with --idempotency-key returns the cached result on retry", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-idem-create-"));
  const documentPath = makeFixturePdf(dir);
  try {
    const first = createSigningRequest(db, {
      title: "Idempotent",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
      idempotencyKey: "key-1",
    });
    assert.equal(first.idempotent, undefined);

    const replay = createSigningRequest(db, {
      // Same key — even with different inputs, the cached result wins.
      title: "Different title shouldn't matter",
      documentPath,
      signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
      idempotencyKey: "key-1",
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.requestId, first.requestId);
    assert.equal(replay.tokens[0].token, first.tokens[0].token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("createSigningRequest with no idempotency key creates a fresh request each call", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-idem-no-key-"));
  const documentPath = makeFixturePdf(dir);
  try {
    const a = createSigningRequest(db, {
      title: "No key",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
    });
    const b = createSigningRequest(db, {
      title: "No key",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 30,
      provider: "local",
      autoApprove: true,
    });
    assert.notEqual(a.requestId, b.requestId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("signSigningRequest with --idempotency-key returns the cached SignerSignResult on retry", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-idem-sign-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Idempotent sign",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const aliceToken = created.tokens[0].token;

      const first = signSigningRequest(db, {
        requestId: created.requestId,
        token: aliceToken,
        idempotencyKey: "sign-key-1",
      });
      assert.equal(first.idempotent, undefined);
      assert.equal(first.requestStatus, "completed");

      const replay = signSigningRequest(db, {
        requestId: created.requestId,
        token: aliceToken,
        idempotencyKey: "sign-key-1",
      });
      assert.equal(replay.idempotent, true);
      assert.equal(replay.signedAt, first.signedAt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("signSigningRequest without --idempotency-key still rejects double-sign with SIGNER_ALREADY_SIGNED", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-idem-no-replay-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "No idempotency",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const aliceToken = created.tokens[0].token;
      signSigningRequest(db, { requestId: created.requestId, token: aliceToken });
      assert.throws(
        () => signSigningRequest(db, { requestId: created.requestId, token: aliceToken }),
        /has already signed/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
