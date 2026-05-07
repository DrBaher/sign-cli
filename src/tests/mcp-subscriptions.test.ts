import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { serveMcpStdio } from "../lib/mcp-server.js";
import {
  _listenerCount,
  _resetResourceWatchersForTests,
  notifyResourceChanged,
  subscribeResource,
} from "../lib/resource-watch.js";
import {
  createSigningRequest,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-subs-"));
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

test("subscribeResource + notifyResourceChanged fan out to URI-specific and wildcard listeners", () => {
  _resetResourceWatchersForTests();
  const seen: string[] = [];
  const seenWild: string[] = [];
  const offSpecific = subscribeResource("request://abc", (uri) => seen.push(uri));
  const offWild = subscribeResource("*", (uri) => seenWild.push(uri));
  notifyResourceChanged("request://abc");
  notifyResourceChanged("request://other");
  assert.deepEqual(seen, ["request://abc"]);
  assert.deepEqual(seenWild, ["request://abc", "request://other"]);
  offSpecific();
  offWild();
  assert.equal(_listenerCount("request://abc"), 0);
});

test("MCP resources/subscribe pushes notifications/resources/updated when audit events land", { concurrency: false }, async () => {
  _resetResourceWatchersForTests();
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup: dbCleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-subs-doc-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Sub test",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });

      const input = new PassThrough();
      const output = new PassThrough();
      const collected: string[] = [];
      output.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim()) collected.push(line);
        }
      });
      const serverPromise = serveMcpStdio({ input, output, db });

      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/subscribe",
        params: { uri: `request://${created.requestId}` },
      })}\n`);

      // Drive an audit event by signing — this should fan out to the subscriber.
      // Give the subscribe message a chance to be processed first.
      await new Promise((resolve) => setTimeout(resolve, 20));
      signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Unsubscribe + close.
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "resources/unsubscribe",
        params: { uri: `request://${created.requestId}` },
      })}\n`);
      input.end();
      await serverPromise;

      const messages = collected.map((line) => JSON.parse(line));
      const subscribeAck = messages.find((m) => m.id === 1);
      assert.ok(subscribeAck, "subscribe should ACK with id=1");
      const updates = messages.filter((m) => m.method === "notifications/resources/updated");
      assert.ok(updates.length >= 1, `expected at least one notifications/resources/updated; got ${updates.length}`);
      assert.equal(updates[0].params.uri, `request://${created.requestId}`);
      const unsubscribeAck = messages.find((m) => m.id === 2);
      assert.ok(unsubscribeAck, "unsubscribe should ACK with id=2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      dbCleanup();
    }
  });
});

test("MCP serveMcpStdio cleans up subscriptions when stdin closes", { concurrency: false }, async () => {
  _resetResourceWatchersForTests();
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const serverPromise = serveMcpStdio({ input, output, db });
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "resources/subscribe",
        params: { uri: "request://anything" },
      })}\n`);
      // Give the loop a tick to register.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(_listenerCount("request://anything"), 1);
      input.end();
      await serverPromise;
      assert.equal(_listenerCount("request://anything"), 0, "stdin close must drop subscriptions");
    } finally {
      db.close();
      cleanup();
    }
  });
});

test("MCP resources/subscribe rejects empty/missing uri with -32602", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    try {
      const input = new PassThrough();
      const output = new PassThrough();
      const collected: string[] = [];
      output.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf8").split("\n")) {
          if (line.trim()) collected.push(line);
        }
      });
      const serverPromise = serveMcpStdio({ input, output, db });
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: {} })}\n`);
      input.end();
      await serverPromise;
      const messages = collected.map((line) => JSON.parse(line));
      const err = messages.find((m) => m.id === 1);
      assert.ok(err);
      assert.equal(err.error.code, -32602);
    } finally {
      db.close();
      cleanup();
    }
  });
});
