import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startMcpHttpServer } from "../lib/mcp-server.js";
import { createDb, makeTempDb } from "./helpers.js";

function listen(opts: Parameters<typeof startMcpHttpServer>[0]): Promise<{ server: ReturnType<typeof startMcpHttpServer>; url: string; address: string }> {
  const server = startMcpHttpServer(opts);
  return new Promise((resolve) => {
    server.on("listening", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}/mcp`, address: addr.address });
    });
  });
}

test("startMcpHttpServer defaults to loopback (127.0.0.1), not 0.0.0.0", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const { server, address } = await listen({ port: 0, db });
  try {
    assert.equal(address, "127.0.0.1", "default bind must be loopback so the MCP surface is not network-exposed");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    cleanup();
  }
});

test("startMcpHttpServer responds with a structured JSON-RPC 413 for oversized bodies (no silent drop)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const { server, url } = await listen({ port: 0, db });
  try {
    const oversized = "x".repeat(1024 * 1024 + 1024); // > 1 MiB
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: oversized,
    });
    assert.equal(res.status, 413);
    const body = await res.json() as { jsonrpc: string; error: { code: number; message: string } };
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.error.code, -32600);
    assert.match(body.error.message, /too large/i);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    cleanup();
  }
});
