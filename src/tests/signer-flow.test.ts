import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSigningRequest,
  declineSigningRequestAsSigner,
  fetchUnsignedDocumentForSigner,
  getSigningRequestStatus,
  listAuditEvents,
  listSignerInbox,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-signer-flow-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousKeys = process.env.SIGN_LOCAL_KEY_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_KEY_DIR = path.join(dir, "keys");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousKeys === undefined) delete process.env.SIGN_LOCAL_KEY_DIR;
    else process.env.SIGN_LOCAL_KEY_DIR = previousKeys;
    if (previousAuto === undefined) delete process.env.SIGN_LOCAL_AUTOCOMPLETE;
    else process.env.SIGN_LOCAL_AUTOCOMPLETE = previousAuto;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
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

type SignerSpec = { name: string; email: string; order: number };

async function bootstrapLocalRequest(input: {
  signers: SignerSpec[];
  title?: string;
  tokenTtlMinutes?: number;
}): Promise<{
  db: ReturnType<typeof createDb>;
  cleanup: () => void;
  documentPath: string;
  requestId: string;
  documentHash: string;
  tokens: Map<string, string>;
}> {
  const { dbPath, cleanup: dbCleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-signer-flow-doc-"));
  const documentPath = makeFixturePdf(dir);
  const created = createSigningRequest(db, {
    title: input.title ?? "Signer-flow test",
    documentPath,
    signers: input.signers,
    tokenTtlMinutes: input.tokenTtlMinutes ?? 30,
    provider: "local",
    autoApprove: true,
  });
  await sendSigningRequest(db, {
    requestId: created.requestId,
    provider: "local",
    testMode: true,
  });
  const tokens = new Map<string, string>();
  for (const issued of created.tokens) {
    tokens.set(issued.signer.email, issued.token);
  }
  return {
    db,
    cleanup: () => {
      db.close();
      dbCleanup();
      rmSync(dir, { recursive: true, force: true });
    },
    documentPath,
    requestId: created.requestId,
    documentHash: created.documentHash,
    tokens,
  };
}

test("multi-signer request stays sent after one signs and flips to completed when all sign", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
    });
    try {
      const first = signSigningRequest(ctx.db, {
        requestId: ctx.requestId,
        token: ctx.tokens.get("alice@example.com")!,
      });
      assert.equal(first.requestStatus, "sent");
      assert.equal(first.remainingSigners, 1);
      assert.equal(first.signedBy.length, 1);

      const interim = await getSigningRequestStatus(ctx.db, {
        requestId: ctx.requestId,
        provider: "local",
      });
      assert.equal(interim.request.status, "sent");

      const second = signSigningRequest(ctx.db, {
        requestId: ctx.requestId,
        token: ctx.tokens.get("bob@example.com")!,
      });
      assert.equal(second.requestStatus, "completed");
      assert.equal(second.remainingSigners, 0);
      assert.equal(second.signedBy.length, 2);

      const final = await getSigningRequestStatus(ctx.db, {
        requestId: ctx.requestId,
        provider: "local",
      });
      assert.equal(final.request.status, "completed");
    } finally {
      ctx.cleanup();
    }
  });
});

test("sign sign --require-hash mismatch throws before any state mutation", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    });
    try {
      const before = listAuditEvents(ctx.db, ctx.requestId).length;
      assert.throws(
        () =>
          signSigningRequest(ctx.db, {
            requestId: ctx.requestId,
            token: ctx.tokens.get("alice@example.com")!,
            requireHash: "0".repeat(64),
          }),
        /Pre-sign safety check failed: --require-hash/u,
      );
      const after = listAuditEvents(ctx.db, ctx.requestId).length;
      assert.equal(after, before, "no audit event must be appended on safety-check failure");
      const status = await getSigningRequestStatus(ctx.db, {
        requestId: ctx.requestId,
        provider: "local",
      });
      assert.equal(status.request.status, "sent");
    } finally {
      ctx.cleanup();
    }
  });
});

test("sign sign rejects an unknown signer-email passed alongside a valid token", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    });
    try {
      assert.throws(
        () =>
          signSigningRequest(ctx.db, {
            requestId: ctx.requestId,
            token: ctx.tokens.get("alice@example.com")!,
            signerEmail: "intruder@example.com",
          }),
        /does not match the signer .* the token authorizes/u,
      );
    } finally {
      ctx.cleanup();
    }
  });
});

test("signer decline records audit event and flips request to declined", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    });
    try {
      const result = declineSigningRequestAsSigner(ctx.db, {
        requestId: ctx.requestId,
        token: ctx.tokens.get("alice@example.com")!,
        reason: "Terms changed since I last reviewed",
      });
      assert.equal(result.signerEmail, "alice@example.com");
      assert.equal(result.reason, "Terms changed since I last reviewed");

      const events = listAuditEvents(ctx.db, ctx.requestId);
      const declineEvent = events.find((event) => event.event_type === "request.signer_declined");
      assert.ok(declineEvent, "audit chain must contain request.signer_declined");
      const payload = JSON.parse(declineEvent.payload_json);
      assert.equal(payload.signerEmail, "alice@example.com");
      assert.equal(payload.reason, "Terms changed since I last reviewed");

      const status = await getSigningRequestStatus(ctx.db, {
        requestId: ctx.requestId,
        provider: "local",
      });
      assert.equal(status.request.status, "declined");
    } finally {
      ctx.cleanup();
    }
  });
});

test("signer list filters by signer-email and only shows pending entries", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
      title: "Inbox-1",
    });
    try {
      const dir = mkdtempSync(path.join(os.tmpdir(), "sign-inbox-other-"));
      const otherDoc = makeFixturePdf(dir);
      const other = createSigningRequest(ctx.db, {
        title: "Inbox-2",
        documentPath: otherDoc,
        signers: [{ name: "Bob", email: "bob@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      const otherBobToken = other.tokens.find((t) => t.signer.email === "bob@example.com")!.token;
      await sendSigningRequest(ctx.db, { requestId: other.requestId, provider: "local", testMode: true });

      const aliceInbox = listSignerInbox(ctx.db, { signerEmail: "alice@example.com" });
      assert.equal(aliceInbox.length, 1);
      assert.equal(aliceInbox[0].requestId, ctx.requestId);

      const bobInbox = listSignerInbox(ctx.db, { signerEmail: "bob@example.com" });
      assert.equal(bobInbox.length, 2);
      assert.deepEqual(
        bobInbox.map((entry) => entry.requestId).sort(),
        [ctx.requestId, other.requestId].sort(),
      );

      signSigningRequest(ctx.db, { requestId: other.requestId, token: otherBobToken });
      const bobInboxAfter = listSignerInbox(ctx.db, { signerEmail: "bob@example.com" });
      assert.equal(bobInboxAfter.length, 1);
      assert.equal(bobInboxAfter[0].requestId, ctx.requestId);

      rmSync(dir, { recursive: true, force: true });
    } finally {
      ctx.cleanup();
    }
  });
});

test("signer fetch-document writes the unsigned PDF and records request.signer_fetched_document", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    });
    const outDir = mkdtempSync(path.join(os.tmpdir(), "sign-fetchdoc-out-"));
    const outPath = path.join(outDir, "fetched.pdf");
    try {
      const result = await fetchUnsignedDocumentForSigner(ctx.db, {
        requestId: ctx.requestId,
        token: ctx.tokens.get("alice@example.com")!,
        outPath,
      });
      assert.equal(result.outPath, outPath);
      assert.equal(result.sha256, ctx.documentHash);
      assert.ok(existsSync(outPath));
      const written = readFileSync(outPath);
      assert.equal(written.length, result.bytes);

      const events = listAuditEvents(ctx.db, ctx.requestId);
      const fetchEvent = events.find((event) => event.event_type === "request.signer_fetched_document");
      assert.ok(fetchEvent, "audit chain must contain request.signer_fetched_document");
      const payload = JSON.parse(fetchEvent.payload_json);
      assert.equal(payload.signerEmail, "alice@example.com");
      assert.equal(payload.sha256, ctx.documentHash);
      assert.equal(payload.outPath, outPath);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      ctx.cleanup();
    }
  });
});

test("signer-side commands refuse non-local providers with a clear message", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-signer-nonlocal-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Non-local refusal",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "dropbox",
        autoApprove: true,
      });
      const token = created.tokens.find((t) => t.signer.email === "alice@example.com")!.token;

      assert.throws(
        () => signSigningRequest(db, { requestId: created.requestId, token }),
        /only supports --provider local/u,
      );
      assert.throws(
        () => declineSigningRequestAsSigner(db, { requestId: created.requestId, token }),
        /only supports --provider local/u,
      );
      await assert.rejects(
        () => fetchUnsignedDocumentForSigner(db, { requestId: created.requestId, token }),
        /only supports --provider local/u,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("SIGN_LOCAL_AUTOCOMPLETE=false keeps a polled local request at sent until a signer signs", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    });
    try {
      for (let i = 0; i < 4; i += 1) {
        const status = await getSigningRequestStatus(ctx.db, {
          requestId: ctx.requestId,
          provider: "local",
        });
        assert.equal(status.request.status, "sent", `poll #${i + 1} unexpectedly auto-completed`);
      }

      const result = signSigningRequest(ctx.db, {
        requestId: ctx.requestId,
        token: ctx.tokens.get("alice@example.com")!,
      });
      assert.equal(result.requestStatus, "completed");
    } finally {
      ctx.cleanup();
    }
  });
});

// --- Token-auth specific scenarios ---

test("sign sign rejects when the token is missing", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    });
    try {
      assert.throws(
        () => signSigningRequest(ctx.db, { requestId: ctx.requestId, token: "" }),
        /--token is required for signer-side commands/u,
      );
    } finally {
      ctx.cleanup();
    }
  });
});

test("sign sign rejects when the token is wrong", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    });
    try {
      assert.throws(
        () => signSigningRequest(ctx.db, { requestId: ctx.requestId, token: "not-a-real-token" }),
        /Token does not match any signer/u,
      );
    } finally {
      ctx.cleanup();
    }
  });
});

test("sign sign rejects when the token belongs to another signer's slot but signer-email is asserted otherwise", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
    });
    try {
      // Pass Bob's token but assert --signer-email is alice — must fail.
      assert.throws(
        () =>
          signSigningRequest(ctx.db, {
            requestId: ctx.requestId,
            token: ctx.tokens.get("bob@example.com")!,
            signerEmail: "alice@example.com",
          }),
        /does not match the signer .* the token authorizes/u,
      );

      // Sanity check: the same wrong-slot scenario where the agent doesn't override is allowed
      // (Bob simply signs his own slot), so the failure above is purely from the cross-check.
      const ok = signSigningRequest(ctx.db, {
        requestId: ctx.requestId,
        token: ctx.tokens.get("bob@example.com")!,
      });
      assert.equal(ok.signerEmail, "bob@example.com");
    } finally {
      ctx.cleanup();
    }
  });
});

test("sign sign rejects an expired token", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-token-expired-"));
    const documentPath = makeFixturePdf(dir);
    try {
      // Mint with a 1-minute TTL, then pass `now` 2 minutes in the future.
      const created = createSigningRequest(db, {
        title: "Token expiry",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 1,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const token = created.tokens[0].token;

      const future = new Date(Date.now() + 2 * 60_000);
      assert.throws(
        () => signSigningRequest(db, { requestId: created.requestId, token, now: future }),
        /Token has expired/u,
      );

      // The fresh path still works inside TTL.
      const ok = signSigningRequest(db, { requestId: created.requestId, token });
      assert.equal(ok.signerEmail, "alice@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("sign sign refuses to sign twice with the same token", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrapLocalRequest({
      signers: [
        { name: "Alice", email: "alice@example.com", order: 1 },
        { name: "Bob", email: "bob@example.com", order: 2 },
      ],
    });
    try {
      const aliceToken = ctx.tokens.get("alice@example.com")!;
      const first = signSigningRequest(ctx.db, { requestId: ctx.requestId, token: aliceToken });
      assert.equal(first.requestStatus, "sent");
      assert.throws(
        () => signSigningRequest(ctx.db, { requestId: ctx.requestId, token: aliceToken }),
        /has already signed request/u,
      );
    } finally {
      ctx.cleanup();
    }
  });
});
