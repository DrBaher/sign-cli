import test from "node:test";
import assert from "node:assert/strict";
import { startHttpApiServer } from "../lib/http-api.js";
import { createDb, makeTempDb } from "./helpers.js";

// X-Forwarded-For is client-controlled. Without --trust-proxy the limiter must
// key on the real socket peer (so spoofing the header can't mint fresh
// buckets); with --trust-proxy it honours the header (load-balancer case).

async function listen(opts: Partial<Parameters<typeof startHttpApiServer>[0]>) {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({ db, port: 0, ...opts });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const close = async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  };
  return { port, close };
}

test("default (trustProxy off): spoofed X-Forwarded-For does NOT escape the limit", async () => {
  const { port, close } = await listen({ rateLimit: { capacity: 2, refillPerSec: 0.1 } });
  try {
    const url = `http://127.0.0.1:${port}/v1/health`;
    // All three come from the same socket; a rotating XFF must not help.
    const a = await fetch(url, { headers: { "x-forwarded-for": "1.1.1.1" } });
    const b = await fetch(url, { headers: { "x-forwarded-for": "2.2.2.2" } });
    const c = await fetch(url, { headers: { "x-forwarded-for": "3.3.3.3" } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 429, "rotating XFF must not mint fresh buckets when trustProxy is off");
  } finally {
    await close();
  }
});

test("trustProxy on: distinct X-Forwarded-For values get distinct buckets", async () => {
  const { port, close } = await listen({ rateLimit: { capacity: 1, refillPerSec: 0.1 }, trustProxy: true });
  try {
    const url = `http://127.0.0.1:${port}/v1/health`;
    // capacity=1, so a second request on the SAME forwarded IP is denied,
    // but a different forwarded IP gets its own fresh bucket.
    const a = await fetch(url, { headers: { "x-forwarded-for": "9.9.9.9" } });
    const aRepeat = await fetch(url, { headers: { "x-forwarded-for": "9.9.9.9" } });
    const other = await fetch(url, { headers: { "x-forwarded-for": "8.8.8.8" } });
    assert.equal(a.status, 200);
    assert.equal(aRepeat.status, 429, "same forwarded IP shares a bucket");
    assert.equal(other.status, 200, "different forwarded IP gets its own bucket");
  } finally {
    await close();
  }
});
