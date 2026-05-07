import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePolicySpec } from "../lib/policy-engine.js";
import {
  createSigningRequest,
  runSignerPolicyAll,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-runall-"));
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

async function startNotifyServer(): Promise<{
  url: string;
  received: Array<{ headers: http.IncomingHttpHeaders; body: any }>;
  close: () => Promise<void>;
}> {
  const received: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        received.push({ headers: req.headers, body: JSON.parse(text) });
      } catch {
        received.push({ headers: req.headers, body: text });
      }
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/notify`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("runSignerPolicyAll applies policy to every inbox entry the agent has a token for", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-runall-doc-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const tokens: Record<string, string> = {};
      const created: Array<{ id: string; title: string }> = [];
      const titles = ["NDA round 1", "Risky addendum to NDA", "Other contract"];
      for (const title of titles) {
        const c = createSigningRequest(db, {
          title,
          documentPath,
          signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
          tokenTtlMinutes: 30,
          provider: "local",
          autoApprove: true,
        });
        await sendSigningRequest(db, { requestId: c.requestId, provider: "local", testMode: true });
        tokens[c.requestId] = c.tokens[0].token;
        created.push({ id: c.requestId, title });
      }

      const spec = parsePolicySpec({
        rules: [
          { match: { titlePattern: "addendum" }, action: "decline", reason: "Addenda need human review" },
          { match: { titlePattern: "^NDA" }, action: "sign" },
          { match: "any", action: "report" },
        ],
      });

      const outcome = runSignerPolicyAll(db, {
        signerEmail: "alice@example.com",
        tokens,
        spec,
      });

      assert.equal(outcome.total, 3);
      assert.equal(outcome.failed, 0);
      const byTitle = new Map(created.map((c) => [c.id, c.title]));
      for (const entry of outcome.results) {
        const title = byTitle.get(entry.requestId)!;
        if (title.includes("addendum")) {
          assert.equal(entry.decision?.action, "decline");
          assert.equal(entry.applied, true);
        } else if (title.startsWith("NDA")) {
          assert.equal(entry.decision?.action, "sign");
          assert.equal(entry.applied, true);
        } else {
          assert.equal(entry.decision?.action, "report");
          assert.equal(entry.applied, false);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("runSignerPolicyAll skips inbox entries with no matching token (no error)", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-runall-skip-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const a = createSigningRequest(db, {
        title: "Has token",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      const b = createSigningRequest(db, {
        title: "No token",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: a.requestId, provider: "local", testMode: true });
      await sendSigningRequest(db, { requestId: b.requestId, provider: "local", testMode: true });

      const spec = parsePolicySpec({ rules: [{ match: "any", action: "sign" }] });
      const outcome = runSignerPolicyAll(db, {
        signerEmail: "alice@example.com",
        tokens: { [a.requestId]: a.tokens[0].token }, // intentionally missing b
        spec,
      });
      assert.equal(outcome.total, 1);
      assert.equal(outcome.results[0].requestId, a.requestId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("runSignerPolicyAll records per-request errors without aborting the loop", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-runall-mixed-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const a = createSigningRequest(db, {
        title: "OK",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      const b = createSigningRequest(db, {
        title: "Will fail",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: a.requestId, provider: "local", testMode: true });
      await sendSigningRequest(db, { requestId: b.requestId, provider: "local", testMode: true });

      const spec = parsePolicySpec({ rules: [{ match: "any", action: "sign" }] });
      // Use a wrong token for b — TOKEN_INVALID surfaces as a per-row error.
      const outcome = runSignerPolicyAll(db, {
        signerEmail: "alice@example.com",
        tokens: {
          [a.requestId]: a.tokens[0].token,
          [b.requestId]: "garbage",
        },
        spec,
      });
      assert.equal(outcome.total, 2);
      assert.equal(outcome.succeeded, 1);
      assert.equal(outcome.failed, 1);
      const failure = outcome.results.find((r) => !r.ok)!;
      assert.equal(failure.error?.code, "TOKEN_INVALID");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("SIGN_LOCAL_NOTIFY_URL receives a JSON POST on allow-listed audit events", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const notifier = await startNotifyServer();
    const previousNotify = process.env.SIGN_LOCAL_NOTIFY_URL;
    process.env.SIGN_LOCAL_NOTIFY_URL = notifier.url;

    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-notify-doc-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Notify test",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });

      // Give the fire-and-forget POST a beat to land.
      const deadline = Date.now() + 1000;
      while (notifier.received.length < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.ok(notifier.received.length >= 1, `expected at least 1 notification, got ${notifier.received.length}`);
      const eventTypes = notifier.received.map((r) => r.body?.eventType);
      assert.ok(eventTypes.includes("request.signed_by_signer"));
      const sample = notifier.received.find((r) => r.body?.eventType === "request.signed_by_signer")!;
      assert.equal(sample.body.requestId, created.requestId);
      assert.equal(typeof sample.body.hashSelf, "string");
    } finally {
      if (previousNotify === undefined) delete process.env.SIGN_LOCAL_NOTIFY_URL;
      else process.env.SIGN_LOCAL_NOTIFY_URL = previousNotify;
      await notifier.close();
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("SIGN_LOCAL_NOTIFY_URL silently no-ops when the URL is unset", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const previousNotify = process.env.SIGN_LOCAL_NOTIFY_URL;
    delete process.env.SIGN_LOCAL_NOTIFY_URL;
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-notify-noop-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "No notify",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });
      // No assertion on side effects — just verifying we don't throw.
    } finally {
      if (previousNotify !== undefined) process.env.SIGN_LOCAL_NOTIFY_URL = previousNotify;
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("SIGN_LOCAL_NOTIFY_URL swallows network errors without breaking signing", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const previousNotify = process.env.SIGN_LOCAL_NOTIFY_URL;
    process.env.SIGN_LOCAL_NOTIFY_URL = "http://127.0.0.1:1/does-not-exist";
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-notify-fail-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Failing notify",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const result = signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });
      assert.equal(result.requestStatus, "completed");
    } finally {
      if (previousNotify === undefined) delete process.env.SIGN_LOCAL_NOTIFY_URL;
      else process.env.SIGN_LOCAL_NOTIFY_URL = previousNotify;
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
