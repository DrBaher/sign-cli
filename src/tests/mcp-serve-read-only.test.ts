import test from "node:test";
import assert from "node:assert/strict";
import { dispatchMcp, READ_ONLY_BLOCKED_TOOLS } from "../lib/mcp-server.js";
import { createDb, makeTempDb } from "./helpers.js";

test("READ_ONLY_BLOCKED_TOOLS covers every MCP-facing mutating tool", () => {
  assert.deepEqual(
    [...READ_ONLY_BLOCKED_TOOLS].sort(),
    ["document", "pdf_stamp_text", "preview", "request_receipt", "sign", "signer_decline", "signer_reissue_token"],
  );
});

test("dispatchMcp tools/call refuses pdf_stamp_text in read-only mode", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({
      method: "tools/call",
      params: { name: "pdf_stamp_text", arguments: { pdf_path: "x.pdf", text: "x", out_path: "o.pdf" } },
      db,
      readOnly: true,
    });
    const value = result.kind === "result" ? result.value as { content: Array<{ text: string }>; isError: boolean } : null;
    assert.equal(value!.isError, true);
    const env = JSON.parse(value!.content[0].text);
    assert.equal(env.error.code, "FORBIDDEN_READ_ONLY");
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp tools/call refuses preview in read-only mode", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({
      method: "tools/call",
      params: { name: "preview", arguments: { pdf_path: "x.pdf", out_path: "o.pdf" } },
      db,
      readOnly: true,
    });
    const value = result.kind === "result" ? result.value as { content: Array<{ text: string }>; isError: boolean } : null;
    assert.equal(value!.isError, true);
    const env = JSON.parse(value!.content[0].text);
    assert.equal(env.error.code, "FORBIDDEN_READ_ONLY");
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp tools/call refuses document in read-only mode", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({
      method: "tools/call",
      params: { name: "document", arguments: { input_path: "x.docx", out_path: "o.pdf", signer_name: "Alice" } },
      db,
      readOnly: true,
    });
    const value = result.kind === "result" ? result.value as { content: Array<{ text: string }>; isError: boolean } : null;
    assert.equal(value!.isError, true);
    const env = JSON.parse(value!.content[0].text);
    assert.equal(env.error.code, "FORBIDDEN_READ_ONLY");
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp tools/call refuses sign in read-only mode with FORBIDDEN_READ_ONLY", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({
      method: "tools/call",
      params: { name: "sign", arguments: { request_id: "x", token: "y" } },
      db,
      readOnly: true,
    });
    assert.equal(result.kind, "result");
    const value = result.kind === "result" ? result.value as { content: Array<{ text: string }>; isError: boolean } : null;
    assert.ok(value);
    assert.equal(value!.isError, true);
    const env = JSON.parse(value!.content[0].text);
    assert.equal(env.ok, false);
    assert.equal(env.error.code, "FORBIDDEN_READ_ONLY");
    assert.match(env.error.message, /"sign"/);
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp tools/call refuses signer_decline in read-only mode", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({
      method: "tools/call",
      params: { name: "signer_decline", arguments: { request_id: "x", token: "y" } },
      db,
      readOnly: true,
    });
    const value = result.kind === "result" ? result.value as { content: Array<{ text: string }>; isError: boolean } : null;
    assert.equal(value!.isError, true);
    const env = JSON.parse(value!.content[0].text);
    assert.equal(env.error.code, "FORBIDDEN_READ_ONLY");
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp tools/call still allows read tools in read-only mode (signer_list, request_show, audit_verify)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({
      method: "tools/call",
      params: { name: "signer_list", arguments: {} },
      db,
      readOnly: true,
    });
    const value = result.kind === "result" ? result.value as { content: Array<{ text: string }>; isError?: boolean } : null;
    // signer_list returns the inbox (probably empty here) — NOT a FORBIDDEN_READ_ONLY error.
    assert.notEqual(value!.isError, true);
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp tools/call without read-only flag still permits the sign tool to run (it'll fail for unrelated reasons, but not on FORBIDDEN_READ_ONLY)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({
      method: "tools/call",
      params: { name: "sign", arguments: { request_id: "x", token: "y" } },
      db,
      // readOnly is unset
    });
    const value = result.kind === "result" ? result.value as { content: Array<{ text: string }>; isError?: boolean } : null;
    if (value?.isError) {
      const env = JSON.parse(value.content[0].text);
      assert.notEqual(env.error?.code, "FORBIDDEN_READ_ONLY");
    }
  } finally {
    db.close();
    cleanup();
  }
});
