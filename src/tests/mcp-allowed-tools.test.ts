import test from "node:test";
import assert from "node:assert/strict";
import { dispatchMcp } from "../lib/mcp-server.js";
import { createDb, makeTempDb } from "./helpers.js";

test("dispatchMcp tools/list with allowedTools filters the catalog to just the named subset", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const allowed = new Set(["signer_list", "request_show"]);
    const result = await dispatchMcp({
      method: "tools/list",
      db,
      allowedTools: allowed,
    });
    const value = result.kind === "result" ? result.value as { tools: Array<{ name: string }> } : null;
    assert.ok(value);
    const names = value!.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["request_show", "signer_list"]);
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp tools/call returns UNKNOWN_TOOL for tools outside the allow-list", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const allowed = new Set(["signer_list"]);
    // request_show exists but is not in the allow-list — must return the
    // same envelope as a real unknown tool so an agent can't differentiate.
    const result = await dispatchMcp({
      method: "tools/call",
      params: { name: "request_show", arguments: { request_id: "x" } },
      db,
      allowedTools: allowed,
    });
    const value = result.kind === "result" ? result.value as { content: Array<{ text: string }>; isError: boolean } : null;
    assert.ok(value);
    assert.equal(value!.isError, true);
    const env = JSON.parse(value!.content[0].text);
    assert.equal(env.error.code, "UNKNOWN_TOOL");
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp tools/call still permits an allow-listed tool through normally", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const allowed = new Set(["signer_list"]);
    const result = await dispatchMcp({
      method: "tools/call",
      params: { name: "signer_list", arguments: {} },
      db,
      allowedTools: allowed,
    });
    const value = result.kind === "result" ? result.value as { content: Array<{ text: string }>; isError?: boolean } : null;
    // signer_list with empty inbox returns an OK result (not isError).
    assert.notEqual(value?.isError, true);
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp without allowedTools shows every tool in the catalog (no implicit allow-list)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({ method: "tools/list", db });
    const value = result.kind === "result" ? result.value as { tools: Array<{ name: string }> } : null;
    assert.ok(value);
    assert.ok(value!.tools.length >= 7); // every tool exposed
  } finally {
    db.close();
    cleanup();
  }
});
