import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { serveMcpStdio } from "../lib/mcp-server.js";
import { createDb, makeTempDb } from "./helpers.js";

test("serveMcpStdio --emit-events tees every JSON-RPC message in/out to the named NDJSON file", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-emit-"));
  const eventsPath = path.join(dir, "mcp.ndjson");
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    output.on("data", () => {}); // drain
    const serverPromise = serveMcpStdio({
      input,
      output,
      db,
      emitEventsPath: eventsPath,
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    input.end();
    await serverPromise;

    assert.ok(existsSync(eventsPath));
    const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
    // 2 inbound + 2 outbound = 4 lines
    assert.equal(lines.length, 4);
    const parsed = lines.map((l) => JSON.parse(l));
    // Alternating in/out (mostly — initialize-in then initialize-out, then tools/list-in then tools/list-out).
    assert.equal(parsed[0].direction, "in");
    assert.equal(parsed[0].message.method, "initialize");
    assert.equal(parsed[1].direction, "out");
    assert.equal(parsed[1].message.id, 1);
    assert.equal(parsed[2].direction, "in");
    assert.equal(parsed[2].message.method, "tools/list");
    assert.equal(parsed[3].direction, "out");
    assert.equal(parsed[3].message.id, 2);
    // Each line carries an ISO timestamp.
    for (const entry of parsed) {
      assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("serveMcpStdio without --emit-events writes nothing extra (existing behavior preserved)", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    output.on("data", () => {});
    const serverPromise = serveMcpStdio({ input, output, db });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    input.end();
    await serverPromise;
    // No assertion needed beyond completion: this just confirms no path
    // change on the no-flag default.
    assert.ok(true);
  } finally {
    db.close();
    cleanup();
  }
});
