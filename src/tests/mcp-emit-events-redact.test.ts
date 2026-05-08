import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { serveMcpStdio } from "../lib/mcp-server.js";
import { createDb, makeTempDb } from "./helpers.js";

test("serveMcpStdio --emit-events --emit-events-redact masks token-shaped fields in the log but not in the wire bytes", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-redact-"));
  const eventsPath = path.join(dir, "mcp.ndjson");
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const wireOut: Buffer[] = [];
    output.on("data", (chunk: Buffer) => wireOut.push(chunk));
    const serverPromise = serveMcpStdio({
      input, output, db,
      emitEventsPath: eventsPath,
      emitEventsRedact: true,
    });
    // Send a tools/call with a "token" argument — the redactor should mask
    // it in the log but the live dispatch still receives the original.
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "sign", arguments: { request_id: "x", token: "supersecret-token-123" } },
    })}\n`);
    input.end();
    await serverPromise;

    const logContent = readFileSync(eventsPath, "utf8");
    // Token replaced in the log.
    assert.ok(!logContent.includes("supersecret-token-123"), "raw token should not appear in the log");
    assert.ok(logContent.includes("<REDACTED>"), "log should contain the <REDACTED> sentinel");

    // The wire bytes that went to the MCP client are unchanged — the
    // redaction only affected the log. We can't easily inspect the request
    // we sent (it's already gone), but we can check that the response
    // came back with NO redaction artifacts (since the response is for a
    // sign tool that errored on a missing request — the error envelope
    // doesn't include the token).
    const wireText = Buffer.concat(wireOut).toString("utf8");
    assert.ok(!wireText.includes("<REDACTED>"), "wire bytes shouldn't contain the redaction sentinel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});

test("serveMcpStdio without --emit-events-redact preserves token values verbatim in the log (default behavior)", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-mcp-redact-default-"));
  const eventsPath = path.join(dir, "mcp.ndjson");
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    output.on("data", () => {});
    const serverPromise = serveMcpStdio({ input, output, db, emitEventsPath: eventsPath });
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "sign", arguments: { request_id: "x", token: "verbatim-token" } },
    })}\n`);
    input.end();
    await serverPromise;
    const logContent = readFileSync(eventsPath, "utf8");
    // Without --emit-events-redact, the token shows up verbatim — this is
    // the documented default. Operators who don't want it must opt in.
    assert.ok(logContent.includes("verbatim-token"));
    assert.ok(!logContent.includes("<REDACTED>"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    db.close();
    cleanup();
  }
});
