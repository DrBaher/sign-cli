import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSigningRequest,
  declineSigningRequestAsSigner,
  fetchUnsignedDocumentForSigner,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { formatCliError, SignCliError } from "../lib/sign-error.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-cli-errors-"));
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

test("formatCliError produces a SignCliError envelope with code/message/hint/details", () => {
  const err = new SignCliError({
    code: "TOKEN_EXPIRED",
    message: "Token has expired (expiresAt=2020-01-01T00:00:00Z).",
    hint: "Re-run request create.",
    details: { requestId: "req_x" },
  });
  const env = formatCliError(err);
  assert.equal(env.ok, false);
  assert.equal(env.error.code, "TOKEN_EXPIRED");
  assert.match(env.error.message, /^Token has expired/);
  assert.equal(env.error.hint, "Re-run request create.");
  assert.deepEqual(env.error.details, { requestId: "req_x" });
});

test("formatCliError tags unknown errors as INTERNAL with no hint or details", () => {
  const env = formatCliError(new Error("kaboom"));
  assert.equal(env.error.code, "INTERNAL");
  assert.equal(env.error.message, "kaboom");
  assert.equal(env.error.hint, undefined);
  assert.equal(env.error.details, undefined);
});

test("formatCliError redacts known secrets in error messages", () => {
  const previous = process.env.DROPBOX_SIGN_API_KEY;
  process.env.DROPBOX_SIGN_API_KEY = "supersecret-abcdef";
  try {
    const env = formatCliError(new Error("upstream said: supersecret-abcdef rejected"));
    assert.doesNotMatch(env.error.message, /supersecret-abcdef/);
    assert.match(env.error.message, /sup\*\*\*ef/);
  } finally {
    if (previous === undefined) delete process.env.DROPBOX_SIGN_API_KEY;
    else process.env.DROPBOX_SIGN_API_KEY = previous;
  }
});

test("token errors carry the documented codes (TOKEN_REQUIRED, TOKEN_INVALID, TOKEN_EXPIRED, TOKEN_SIGNER_MISMATCH)", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-cli-errors-doc-"));
    const documentPath = path.join(dir, "doc.pdf");
    writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
    try {
      const created = createSigningRequest(db, {
        title: "Codes test",
        documentPath,
        signers: [
          { name: "Alice", email: "alice@example.com", order: 1 },
          { name: "Bob", email: "bob@example.com", order: 2 },
        ],
        tokenTtlMinutes: 1,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const aliceToken = created.tokens.find((t) => t.signer.email === "alice@example.com")!.token;

      const required = expectSignError(() => signSigningRequest(db, { requestId: created.requestId, token: "" }));
      assert.equal(required.code, "TOKEN_REQUIRED");

      const invalid = expectSignError(() => signSigningRequest(db, { requestId: created.requestId, token: "garbage" }));
      assert.equal(invalid.code, "TOKEN_INVALID");

      const expired = expectSignError(() =>
        signSigningRequest(db, {
          requestId: created.requestId,
          token: aliceToken,
          now: new Date(Date.now() + 5 * 60_000),
        }),
      );
      assert.equal(expired.code, "TOKEN_EXPIRED");

      const mismatch = expectSignError(() =>
        signSigningRequest(db, {
          requestId: created.requestId,
          token: aliceToken,
          signerEmail: "bob@example.com",
        }),
      );
      assert.equal(mismatch.code, "TOKEN_SIGNER_MISMATCH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("pre-sign safety, signer_already_signed, and non_local errors carry their codes", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-cli-errors-doc-"));
    const documentPath = path.join(dir, "doc.pdf");
    writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
    try {
      const created = createSigningRequest(db, {
        title: "Codes-pre-sign",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const aliceToken = created.tokens[0].token;

      const hash = expectSignError(() =>
        signSigningRequest(db, { requestId: created.requestId, token: aliceToken, requireHash: "0".repeat(64) }),
      );
      assert.equal(hash.code, "PRE_SIGN_HASH_MISMATCH");

      const title = expectSignError(() =>
        signSigningRequest(db, { requestId: created.requestId, token: aliceToken, requireTitle: "^never$" }),
      );
      assert.equal(title.code, "PRE_SIGN_TITLE_MISMATCH");

      const badRegex = expectSignError(() =>
        signSigningRequest(db, { requestId: created.requestId, token: aliceToken, requireTitle: "(" }),
      );
      assert.equal(badRegex.code, "PRE_SIGN_TITLE_BAD_REGEX");

      // First sign succeeds, second flags SIGNER_ALREADY_SIGNED
      signSigningRequest(db, { requestId: created.requestId, token: aliceToken });
      const replay = expectSignError(() => signSigningRequest(db, { requestId: created.requestId, token: aliceToken }));
      assert.equal(replay.code, "SIGNER_ALREADY_SIGNED");

      // Non-local refusal: make a Dropbox request (no network needed because we never call .send)
      const dropbox = createSigningRequest(db, {
        title: "Non-local",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "dropbox",
        autoApprove: true,
      });
      const dropboxToken = dropbox.tokens[0].token;
      const nonLocal = expectSignError(() =>
        signSigningRequest(db, { requestId: dropbox.requestId, token: dropboxToken }),
      );
      assert.equal(nonLocal.code, "NON_LOCAL_PROVIDER");
      const nonLocalDecline = expectSignError(() =>
        declineSigningRequestAsSigner(db, { requestId: dropbox.requestId, token: dropboxToken }),
      );
      assert.equal(nonLocalDecline.code, "NON_LOCAL_PROVIDER");
      // fetchUnsignedDocumentForSigner is async now (existingSignatures
      // surface requires PDF inspection), so use await + try/catch.
      let nonLocalFetchCode = "";
      try {
        await fetchUnsignedDocumentForSigner(db, { requestId: dropbox.requestId, token: dropboxToken });
      } catch (err) {
        if (err instanceof SignCliError) nonLocalFetchCode = err.code;
        else throw err;
      }
      assert.equal(nonLocalFetchCode, "NON_LOCAL_PROVIDER");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

function expectSignError(fn: () => unknown): SignCliError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SignCliError) return error;
    throw new Error(`Expected SignCliError, got ${(error as Error).constructor?.name}: ${(error as Error).message}`);
  }
  throw new Error("Expected fn to throw, but it did not.");
}
