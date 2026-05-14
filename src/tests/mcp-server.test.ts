import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  createSigningRequest,
  sendSigningRequest,
} from "../lib/signing-service.js";
import {
  dispatchMcp,
  listMcpTools,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  serveMcpStdio,
} from "../lib/mcp-server.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-"));
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
  bobToken: string;
}> {
  const { dbPath, cleanup: dbCleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-doc-"));
  const documentPath = makeFixturePdf(dir);
  const created = createSigningRequest(db, {
    title: "MCP test",
    documentPath,
    signers: [
      { name: "Alice", email: "alice@example.com", order: 1 },
      { name: "Bob", email: "bob@example.com", order: 2 },
    ],
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
    aliceToken: created.tokens.find((t) => t.signer.email === "alice@example.com")!.token,
    bobToken: created.tokens.find((t) => t.signer.email === "bob@example.com")!.token,
  };
}

test("dispatchMcp initialize returns protocol version + serverInfo", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const dispatch = await dispatchMcp({ method: "initialize", db: ctx.db });
      assert.equal(dispatch.kind, "result");
      const result = (dispatch as { kind: "result"; value: any }).value;
      assert.equal(result.protocolVersion, MCP_PROTOCOL_VERSION);
      assert.equal(result.serverInfo.name, MCP_SERVER_NAME);
      assert.ok(result.capabilities.tools);
    } finally {
      ctx.cleanup();
    }
  });
});

test("dispatchMcp tools/list lists every signer-side tool", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const dispatch = await dispatchMcp({ method: "tools/list", db: ctx.db });
      assert.equal(dispatch.kind, "result");
      const value = (dispatch as { kind: "result"; value: any }).value;
      const names = (value.tools as Array<{ name: string }>).map((t) => t.name).sort();
      assert.deepEqual(names, [
        "audit_scan",
        "audit_verify",
        "document",
        "pdf_detect_date_field",
        "pdf_detect_signature_field",
        "pdf_inspect_signatures",
        "pdf_stamp_text",
        "preview",
        "profile_list",
        "profile_show",
        "request_receipt",
        "request_show",
        "request_status",
        "request_watch",
        "sign",
        "signer_decline",
        "signer_fetch_document",
        "signer_list",
        "signer_reissue_token",
      ]);
    } finally {
      ctx.cleanup();
    }
  });
});

test("dispatchMcp tools/call signer_list returns the inbox", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const dispatch = await dispatchMcp({
        method: "tools/call",
        params: { name: "signer_list", arguments: { signer_email: "alice@example.com" } },
        db: ctx.db,
      });
      const result = (dispatch as { kind: "result"; value: any }).value;
      assert.equal(result.isError, undefined);
      const inbox = JSON.parse(result.content[0].text);
      assert.equal(inbox.length, 1);
      assert.equal(inbox[0].requestId, ctx.requestId);
    } finally {
      ctx.cleanup();
    }
  });
});

test("dispatchMcp tools/call sign signs the request and returns the structured result", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const dispatch = await dispatchMcp({
        method: "tools/call",
        params: { name: "sign", arguments: { request_id: ctx.requestId, token: ctx.aliceToken } },
        db: ctx.db,
      });
      const result = (dispatch as { kind: "result"; value: any }).value;
      assert.equal(result.isError, undefined);
      const signResult = JSON.parse(result.content[0].text);
      assert.equal(signResult.signerEmail, "alice@example.com");
      assert.equal(signResult.requestStatus, "sent");
      assert.equal(signResult.remainingSigners, 1);
    } finally {
      ctx.cleanup();
    }
  });
});

test("dispatchMcp wraps tool errors as isError content with a SignCliError envelope", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const dispatch = await dispatchMcp({
        method: "tools/call",
        params: { name: "sign", arguments: { request_id: ctx.requestId, token: "garbage" } },
        db: ctx.db,
      });
      const result = (dispatch as { kind: "result"; value: any }).value;
      assert.equal(result.isError, true);
      const envelope = JSON.parse(result.content[0].text);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.error.code, "TOKEN_INVALID");
    } finally {
      ctx.cleanup();
    }
  });
});

test("dispatchMcp returns UNKNOWN_TOOL for an unrecognized name", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
    try {
      const dispatch = await dispatchMcp({
        method: "tools/call",
        params: { name: "does_not_exist", arguments: {} },
        db: ctx.db,
      });
      const result = (dispatch as { kind: "result"; value: any }).value;
      assert.equal(result.isError, true);
      const envelope = JSON.parse(result.content[0].text);
      assert.equal(envelope.error.code, "UNKNOWN_TOOL");
    } finally {
      ctx.cleanup();
    }
  });
});

test("listMcpTools shapes match the input schema contract", () => {
  const tools = listMcpTools();
  assert.ok(tools.length >= 7);
  for (const tool of tools) {
    assert.equal(typeof tool.name, "string");
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.inputSchema, "object");
    assert.equal((tool.inputSchema as { type?: string }).type, "object");
  }
});

test("listMcpTools exposes outputSchema for every tool so generic agents can validate responses", () => {
  const tools = listMcpTools();
  for (const tool of tools) {
    assert.ok(
      tool.outputSchema && typeof tool.outputSchema === "object",
      `tool "${tool.name}" should expose an outputSchema`,
    );
    const t = (tool.outputSchema as { type?: string }).type;
    assert.ok(t === "object" || t === "array", `tool "${tool.name}" outputSchema.type must be object or array`);
  }
});

test("serveMcpStdio handles initialize + tools/list + tools/call over piped streams", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
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
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "signer_list", arguments: { signer_email: "bob@example.com" } },
        })}\n`,
      );
      input.end();
      await serverPromise;
    } finally {
      ctx.cleanup();
    }

    assert.equal(collected.length, 3, `expected 3 responses, got ${collected.length}: ${collected.join(" | ")}`);
    const initResp = JSON.parse(collected[0]);
    assert.equal(initResp.id, 1);
    assert.equal(initResp.result.protocolVersion, MCP_PROTOCOL_VERSION);

    const listResp = JSON.parse(collected[1]);
    assert.equal(listResp.id, 2);
    assert.ok(listResp.result.tools.length >= 7);

    const callResp = JSON.parse(collected[2]);
    assert.equal(callResp.id, 3);
    const inbox = JSON.parse(callResp.result.content[0].text);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].requestId, ctx.requestId);
  });
});

test("serveMcpStdio emits a JSON-RPC parse error for invalid JSON input", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap();
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
      input.write("not-json\n");
      input.end();
      await serverPromise;
    } finally {
      ctx.cleanup();
    }
    assert.equal(collected.length, 1);
    const resp = JSON.parse(collected[0]);
    assert.equal(resp.error.code, -32700);
    assert.equal(resp.error.message, "Parse error");
  });
});
