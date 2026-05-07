import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { attachPrettyAuditPrinter, formatAuditLine } from "../lib/audit-pretty.js";
import {
  _resetResourceWatchersForTests,
} from "../lib/resource-watch.js";
import {
  createSigningRequest,
  declineSigningRequestAsSigner,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-pretty-"));
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

test("formatAuditLine includes timestamp, requestId, event type, and a short summary", () => {
  const line = formatAuditLine(
    {
      id: 1,
      event_type: "request.signed_by_signer",
      payload_json: JSON.stringify({ signerEmail: "alice@example.com", remainingSigners: 0 }),
      hash_self: "abcdef0123456789".padEnd(64, "0"),
      created_at: "2026-05-07T12:34:56.789Z",
    },
    "req_abc",
  );
  assert.match(line, /^\[2026-05-07 12:34:56Z\]/);
  assert.match(line, /req_abc/);
  assert.match(line, /request\.signed_by_signer/);
  assert.match(line, /signerEmail=alice@example.com/);
  assert.match(line, /#abcdef01/);
});

test("attachPrettyAuditPrinter writes one line per audit event (deduped across both URI fanouts)", { concurrency: false }, async () => {
  _resetResourceWatchersForTests();
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-pretty-flow-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Pretty test",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });

      const sink = new PassThrough();
      const collected: string[] = [];
      sink.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim()) collected.push(line);
        }
      });
      const detach = attachPrettyAuditPrinter(db, sink);
      try {
        signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });
      } finally {
        detach();
      }
      // One line per audit event regardless of how many URIs the watcher fans out to.
      const signedLines = collected.filter((l) => l.includes("request.signed_by_signer"));
      assert.equal(signedLines.length, 1, `expected exactly 1 signed-by-signer line, got ${signedLines.length}`);
      assert.match(signedLines[0], /alice@example\.com/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("attachPrettyAuditPrinter detaches cleanly on cleanup", { concurrency: false }, async () => {
  _resetResourceWatchersForTests();
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-audit-pretty-detach-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Detach test",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });

      const sink = new PassThrough();
      const collected: string[] = [];
      sink.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim()) collected.push(line);
        }
      });
      const detach = attachPrettyAuditPrinter(db, sink);
      detach();
      // After detach, new audit events shouldn't print.
      declineSigningRequestAsSigner(db, { requestId: created.requestId, token: created.tokens[0].token });
      assert.equal(collected.length, 0, `expected 0 lines after detach, got ${collected.length}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
