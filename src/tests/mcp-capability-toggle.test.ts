import test from "node:test";
import assert from "node:assert/strict";
import { dispatchMcp } from "../lib/mcp-server.js";
import { SignCliError } from "../lib/sign-error.js";
import { createDb, makeTempDb } from "./helpers.js";

test("dispatchMcp initialize with --capability tools advertises only tools (no resources/prompts)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({
      method: "initialize",
      db,
      capabilities: new Set(["tools"]),
    });
    const value = result.kind === "result" ? result.value as { capabilities: Record<string, unknown> } : null;
    assert.ok(value);
    assert.deepEqual(Object.keys(value!.capabilities).sort(), ["tools"]);
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp resources/list refuses with INVALID_ARGS when resources capability is disabled", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    await assert.rejects(
      () => dispatchMcp({
        method: "resources/list",
        db,
        capabilities: new Set(["tools"]),
      }),
      (err: unknown) => err instanceof SignCliError && err.code === "INVALID_ARGS",
    );
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp prompts/list refuses when prompts capability is disabled but tools/list still works", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    await assert.rejects(
      () => dispatchMcp({
        method: "prompts/list",
        db,
        capabilities: new Set(["tools"]),
      }),
      (err: unknown) => err instanceof SignCliError && err.code === "INVALID_ARGS",
    );
    const tools = await dispatchMcp({
      method: "tools/list",
      db,
      capabilities: new Set(["tools"]),
    });
    const value = tools.kind === "result" ? tools.value as { tools: unknown[] } : null;
    assert.ok(value && value.tools.length > 0);
  } finally {
    db.close();
    cleanup();
  }
});

test("dispatchMcp without capabilities advertises all three (existing behavior preserved)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const result = await dispatchMcp({ method: "initialize", db });
    const value = result.kind === "result" ? result.value as { capabilities: Record<string, unknown> } : null;
    assert.deepEqual(Object.keys(value!.capabilities).sort(), ["prompts", "resources", "tools"]);
  } finally {
    db.close();
    cleanup();
  }
});
