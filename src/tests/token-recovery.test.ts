import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSigningRequest,
  listAuditEvents,
  listSignerInbox,
  reissueSignerToken,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { SignCliError } from "../lib/sign-error.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-token-recovery-"));
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

async function bootstrap(input: { tokenTtlMinutes?: number } = {}): Promise<{
  db: ReturnType<typeof createDb>;
  cleanup: () => void;
  requestId: string;
  aliceToken: string;
}> {
  const { dbPath, cleanup: dbCleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-token-recovery-doc-"));
  const documentPath = makeFixturePdf(dir);
  const created = createSigningRequest(db, {
    title: "Token recovery test",
    documentPath,
    signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    tokenTtlMinutes: input.tokenTtlMinutes ?? 30,
    provider: "local",
    autoApprove: true,
  });
  await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
  return {
    db,
    cleanup: () => {
      db.close();
      dbCleanup();
      rmSync(dir, { recursive: true, force: true });
    },
    requestId: created.requestId,
    aliceToken: created.tokens[0].token,
  };
}

test("reissueSignerToken invalidates the old token and returns a new working one", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const reissued = reissueSignerToken(ctx.db, {
        requestId: ctx.requestId,
        signerEmail: "alice@example.com",
        tokenTtlMinutes: 60,
      });
      assert.notEqual(reissued.token, ctx.aliceToken);
      assert.equal(reissued.signerEmail, "alice@example.com");

      // Old token rejected.
      assert.throws(
        () => signSigningRequest(ctx.db, { requestId: ctx.requestId, token: ctx.aliceToken }),
        (err: unknown) => err instanceof SignCliError && err.code === "TOKEN_INVALID",
      );

      // New token signs successfully.
      const result = signSigningRequest(ctx.db, { requestId: ctx.requestId, token: reissued.token });
      assert.equal(result.requestStatus, "completed");
    } finally {
      ctx.cleanup();
    }
  });
});

test("reissueSignerToken records request.signer_token_reissued in the audit chain", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const reissued = reissueSignerToken(ctx.db, {
        requestId: ctx.requestId,
        signerEmail: "alice@example.com",
      });
      const events = listAuditEvents(ctx.db, ctx.requestId);
      const event = events.find((e) => e.event_type === "request.signer_token_reissued");
      assert.ok(event, "expected request.signer_token_reissued in audit chain");
      const payload = JSON.parse(event.payload_json);
      assert.equal(payload.signerEmail, "alice@example.com");
      assert.equal(payload.tokenHint, reissued.tokenHint);
      assert.equal(payload.expiresAt, reissued.expiresAt);
    } finally {
      ctx.cleanup();
    }
  });
});

test("reissueSignerToken refuses when the signer has already signed", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      signSigningRequest(ctx.db, { requestId: ctx.requestId, token: ctx.aliceToken });
      assert.throws(
        () => reissueSignerToken(ctx.db, { requestId: ctx.requestId, signerEmail: "alice@example.com" }),
        (err: unknown) => err instanceof SignCliError && err.code === "SIGNER_ALREADY_SIGNED",
      );
    } finally {
      ctx.cleanup();
    }
  });
});

test("reissueSignerToken rejects an unknown signer with SIGNER_NOT_RECIPIENT", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      assert.throws(
        () => reissueSignerToken(ctx.db, { requestId: ctx.requestId, signerEmail: "ghost@example.com" }),
        (err: unknown) => err instanceof SignCliError && err.code === "SIGNER_NOT_RECIPIENT",
      );
    } finally {
      ctx.cleanup();
    }
  });
});

test("listSignerInbox enriches each entry with tokens[] including expiresAt and expiresSoon", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap({ tokenTtlMinutes: 60 });
    try {
      const inbox = listSignerInbox(ctx.db, { signerEmail: "alice@example.com" });
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0].tokens.length, 1);
      const tokenInfo = inbox[0].tokens[0];
      assert.equal(tokenInfo.signerEmail, "alice@example.com");
      assert.equal(tokenInfo.expired, false);
      assert.equal(tokenInfo.expiresSoon, false);
      assert.match(tokenInfo.expiresAt, /T/);
      assert.equal(typeof tokenInfo.tokenHint, "string");
    } finally {
      ctx.cleanup();
    }
  });
});

test("listSignerInbox flags expiresSoon for tokens within 5 minutes", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap({ tokenTtlMinutes: 60 });
    try {
      // Pretend "now" is 58 minutes after creation: 2 min remaining → expiresSoon=true.
      const future = new Date(Date.now() + 58 * 60_000);
      const inbox = listSignerInbox(ctx.db, { signerEmail: "alice@example.com", now: future });
      assert.equal(inbox[0].tokens[0].expiresSoon, true);
      assert.equal(inbox[0].tokens[0].expired, false);

      // 65 minutes in: token expired.
      const farFuture = new Date(Date.now() + 65 * 60_000);
      const inboxLater = listSignerInbox(ctx.db, { signerEmail: "alice@example.com", now: farFuture });
      assert.equal(inboxLater[0].tokens[0].expired, true);
      assert.equal(inboxLater[0].tokens[0].expiresSoon, false);
    } finally {
      ctx.cleanup();
    }
  });
});
