import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _resetResourceWatchersForTests } from "../lib/resource-watch.js";
import { runSignerWatch } from "../lib/signer-watch.js";
import {
  createSigningRequest,
  sendSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-signer-watch-"));
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

test("runSignerWatch with --exit-on-first emits the first new inbox entry and stops", { concurrency: false }, async () => {
  _resetResourceWatchersForTests();
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-signer-watch-doc-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const seenEmails: string[] = [];
      // Kick off the watcher; trigger a new request shortly after.
      const watchPromise = runSignerWatch(db, {
        signerEmail: "alice@example.com",
        exitOnFirst: true,
        timeoutMs: 2000,
        pollIntervalMs: 25,
        onEntry: (entry) => {
          if (entry.firstSeen) seenEmails.push(entry.title);
        },
      });
      setTimeout(() => {
        const created = createSigningRequest(db, {
          title: "Watcher target",
          documentPath,
          signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
          tokenTtlMinutes: 30,
          provider: "local",
          autoApprove: true,
        });
        // Inbox needs the request to be in `sent` state — fire-and-forget the send.
        void sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      }, 50);
      const outcome = await watchPromise;
      assert.equal(outcome.exitReason, "exit_on_first");
      assert.equal(outcome.newEntries.length, 1);
      assert.equal(outcome.newEntries[0].title, "Watcher target");
      assert.deepEqual(seenEmails, ["Watcher target"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("runSignerWatch reports timeout exitReason and exit code 4 when nothing new arrives", { concurrency: false }, async () => {
  _resetResourceWatchersForTests();
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    try {
      const outcome = await runSignerWatch(db, {
        signerEmail: "ghost@example.com",
        exitOnFirst: true,
        timeoutMs: 100,
        pollIntervalMs: 20,
      });
      assert.equal(outcome.exitReason, "timeout");
      assert.equal(outcome.newEntries.length, 0);
    } finally {
      db.close();
      cleanup();
    }
  });
});

test("runSignerWatch lists initial inbox entries with firstSeen=false", { concurrency: false }, async () => {
  _resetResourceWatchersForTests();
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-signer-watch-initial-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Already pending",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });

      const flags: Array<{ requestId: string | null; firstSeen: boolean }> = [];
      const outcome = await runSignerWatch(db, {
        signerEmail: "alice@example.com",
        timeoutMs: 50,
        pollIntervalMs: 10,
        onEntry: (entry) => flags.push({ requestId: entry.requestId, firstSeen: entry.firstSeen }),
      });
      assert.equal(outcome.exitReason, "timeout");
      assert.equal(outcome.initialEntries.length, 1);
      assert.equal(outcome.initialEntries[0].requestId, created.requestId);
      assert.deepEqual(flags, [{ requestId: created.requestId, firstSeen: false }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
