import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  createSigningRequest,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { dispatchMcp, serveMcpStdio } from "../lib/mcp-server.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-ext-"));
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

async function bootstrap(): Promise<{
  db: ReturnType<typeof createDb>;
  cleanup: () => void;
  requestId: string;
  aliceToken: string;
}> {
  const { dbPath, cleanup: dbCleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-ext-doc-"));
  const documentPath = makeFixturePdf(dir);
  const created = createSigningRequest(db, {
    title: "MCP ext test",
    documentPath,
    signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    tokenTtlMinutes: 30,
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

test("dispatchMcp rejects tools/call with INVALID_ARGS when required argument is missing", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const dispatch = await dispatchMcp({
        method: "tools/call",
        params: { name: "sign", arguments: { token: ctx.aliceToken } }, // missing request_id
        db: ctx.db,
      });
      const value = (dispatch as { kind: "result"; value: any }).value;
      assert.equal(value.isError, true);
      const envelope = JSON.parse(value.content[0].text);
      assert.equal(envelope.error.code, "INVALID_ARGS");
      assert.match(envelope.error.message, /request_id/);
    } finally {
      ctx.cleanup();
    }
  });
});

test("dispatchMcp rejects tools/call with INVALID_ARGS when a string field receives a number", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const dispatch = await dispatchMcp({
        method: "tools/call",
        params: {
          name: "sign",
          arguments: { request_id: 123, token: ctx.aliceToken },
        },
        db: ctx.db,
      });
      const value = (dispatch as { kind: "result"; value: any }).value;
      assert.equal(value.isError, true);
      const envelope = JSON.parse(value.content[0].text);
      assert.equal(envelope.error.code, "INVALID_ARGS");
      assert.match(envelope.error.message, /must be a string/);
    } finally {
      ctx.cleanup();
    }
  });
});

test("dispatchMcp resources/list returns request:// URIs for every local request", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const dispatch = await dispatchMcp({ method: "resources/list", db: ctx.db });
      const value = (dispatch as { kind: "result"; value: any }).value;
      const uris = (value.resources as Array<{ uri: string }>).map((r) => r.uri).sort();
      assert.deepEqual(uris, [
        `request://${ctx.requestId}`,
        `request://${ctx.requestId}/audit`,
        `request://${ctx.requestId}/document`,
      ]);
    } finally {
      ctx.cleanup();
    }
  });
});

test("dispatchMcp resources/read returns the snapshot, audit chain, and PDF blob", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const snapDispatch = await dispatchMcp({
        method: "resources/read",
        params: { uri: `request://${ctx.requestId}` },
        db: ctx.db,
      });
      const snap = (snapDispatch as { kind: "result"; value: any }).value;
      assert.equal(snap.contents[0].mimeType, "application/json");
      const snapshot = JSON.parse(snap.contents[0].text);
      assert.equal(snapshot.request.id, ctx.requestId);
      assert.ok(snapshot.nextSteps);

      const auditDispatch = await dispatchMcp({
        method: "resources/read",
        params: { uri: `request://${ctx.requestId}/audit` },
        db: ctx.db,
      });
      const audit = (auditDispatch as { kind: "result"; value: any }).value;
      const events = JSON.parse(audit.contents[0].text);
      assert.ok(Array.isArray(events) && events.length > 0);

      const docDispatch = await dispatchMcp({
        method: "resources/read",
        params: { uri: `request://${ctx.requestId}/document` },
        db: ctx.db,
      });
      const doc = (docDispatch as { kind: "result"; value: any }).value;
      assert.equal(doc.contents[0].mimeType, "application/pdf");
      const pdf = Buffer.from(doc.contents[0].blob, "base64");
      assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
    } finally {
      ctx.cleanup();
    }
  });
});

test("dispatchMcp resources/read throws UNKNOWN_RESOURCE for unknown schemes/leaves", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      // Bad scheme
      await assert.rejects(
        dispatchMcp({ method: "resources/read", params: { uri: "file:///etc/passwd" }, db: ctx.db }),
        /Unknown resource URI scheme/,
      );
      // Bad leaf
      await assert.rejects(
        dispatchMcp({ method: "resources/read", params: { uri: `request://${ctx.requestId}/secrets` }, db: ctx.db }),
        /Unknown resource leaf/,
      );
    } finally {
      ctx.cleanup();
    }
  });
});

test("request_watch returns terminal status and emits progress when the client supplies a progressToken", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      // Sign first so that the watch poll terminates immediately.
      signSigningRequest(ctx.db, { requestId: ctx.requestId, token: ctx.aliceToken });

      const progressEvents: Array<{ progress: number; message?: string }> = [];
      const dispatch = await dispatchMcp({
        method: "tools/call",
        params: {
          name: "request_watch",
          arguments: { request_id: ctx.requestId, provider: "local", interval_ms: 5, timeout_ms: 1000 },
          _meta: { progressToken: "watch-1" },
        },
        db: ctx.db,
        emitProgress: (event) => progressEvents.push(event),
      });
      const value = (dispatch as { kind: "result"; value: any }).value;
      assert.equal(value.isError, undefined);
      const watchResult = JSON.parse(value.content[0].text);
      assert.equal(watchResult.terminal, "completed");
      assert.ok(progressEvents.length >= 1, `expected at least 1 progress event, got ${progressEvents.length}`);
      assert.equal(typeof progressEvents[0].progress, "number");
    } finally {
      ctx.cleanup();
    }
  });
});

test("serveMcpStdio writes notifications/progress messages with the client-supplied progressToken", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    signSigningRequest(ctx.db, { requestId: ctx.requestId, token: ctx.aliceToken });
    const input = new PassThrough();
    const output = new PassThrough();
    const collected: string[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) collected.push(line);
      }
    });
    const serverPromise = serveMcpStdio({ input, output, db: ctx.db });
    try {
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "request_watch",
          arguments: { request_id: ctx.requestId, provider: "local", interval_ms: 5, timeout_ms: 1000 },
          _meta: { progressToken: "abc-123" },
        },
      })}\n`);
      input.end();
      await serverPromise;
    } finally {
      ctx.cleanup();
    }
    const messages = collected.map((line) => JSON.parse(line));
    const progress = messages.filter((m) => m.method === "notifications/progress");
    assert.ok(progress.length >= 1);
    assert.equal(progress[0].params.progressToken, "abc-123");
    const finalResp = messages.find((m) => m.id === 1);
    assert.ok(finalResp, "expected a final response with id=1");
  });
});
