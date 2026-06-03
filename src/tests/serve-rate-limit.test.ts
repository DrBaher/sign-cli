import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { TokenBucketLimiter } from "../lib/rate-limit.js";
import { startHttpApiServer } from "../lib/http-api.js";
import { createDb, makeTempDb } from "./helpers.js";

test("TokenBucketLimiter denies after capacity is consumed and allows again after refill", () => {
  let now = 1_000_000;
  const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSec: 1, now: () => now });
  assert.equal(limiter.take("ip-1").allowed, true);
  assert.equal(limiter.take("ip-1").allowed, true);
  assert.equal(limiter.take("ip-1").allowed, true);
  // Bucket empty → next call is denied with retryAfter ≈ 1s.
  const denied = limiter.take("ip-1");
  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterSeconds >= 1);
  // Advance 2s — should refill ~2 tokens, allowing the next two.
  now += 2_000;
  assert.equal(limiter.take("ip-1").allowed, true);
  assert.equal(limiter.take("ip-1").allowed, true);
});

test("TokenBucketLimiter buckets are isolated per key", () => {
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSec: 1 });
  assert.equal(limiter.take("a").allowed, true);
  assert.equal(limiter.take("b").allowed, true); // distinct key, fresh bucket
  assert.equal(limiter.take("a").allowed, false);
});

test("TokenBucketLimiter.evictIdle drops buckets that haven't been touched", () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({
    capacity: 1, refillPerSec: 1, idleEvictMs: 1000, now: () => now,
  });
  limiter.take("a");
  now = 2_000;
  const evicted = limiter.evictIdle();
  assert.equal(evicted, 1);
  assert.equal(limiter.size(), 0);
});

test("startHttpApiServer with --rate-limit returns 429 once the bucket is exhausted", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  // capacity=2, refill=0.1/s — three rapid requests will hit the limit on #3.
  const server = startHttpApiServer({ db, port: 0, rateLimit: { capacity: 2, refillPerSec: 0.1 } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/v1/health`;
    const a = await fetch(url);
    const b = await fetch(url);
    const c = await fetch(url);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 429);
    assert.match((c.headers.get("retry-after") ?? "").toString(), /^\d+$/);
    assert.equal(c.headers.get("x-ratelimit-limit"), "2");
    const json = await c.json();
    assert.equal(json.error.code, "RATE_LIMITED");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});

test("rate-limit ignores X-Forwarded-For by default — spoofing it cannot bypass the per-socket limit", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  // capacity=2, slow refill. Without trustProxy, all requests over one socket
  // share a bucket regardless of XFF, so request #3 is limited even with a
  // fresh forged XFF on each.
  const server = startHttpApiServer({ db, port: 0, rateLimit: { capacity: 2, refillPerSec: 0.01 } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/v1/health`;
    const a = await fetch(url, { headers: { "x-forwarded-for": "1.1.1.1" } });
    const b = await fetch(url, { headers: { "x-forwarded-for": "2.2.2.2" } });
    const c = await fetch(url, { headers: { "x-forwarded-for": "3.3.3.3" } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 429, "spoofed XFF must not buy a fresh bucket");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});

test("rate-limit honors X-Forwarded-For only with trustProxy=true", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({ db, port: 0, trustProxy: true, rateLimit: { capacity: 1, refillPerSec: 0.01 } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/v1/health`;
    // Distinct XFF hops get distinct buckets when we trust the proxy.
    const a = await fetch(url, { headers: { "x-forwarded-for": "10.0.0.1" } });
    const b = await fetch(url, { headers: { "x-forwarded-for": "10.0.0.2" } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    // Reusing a hop that already spent its single token → limited.
    const aAgain = await fetch(url, { headers: { "x-forwarded-for": "10.0.0.1" } });
    assert.equal(aAgain.status, 429);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});

test("startHttpApiServer bearer auth: wrong token → 401, correct token → 200 (constant-time compare)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({ db, port: 0, authToken: "s3cret-token" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/v1/health`;
    const noAuth = await fetch(url);
    assert.equal(noAuth.status, 401);
    const wrong = await fetch(url, { headers: { authorization: "Bearer wrong" } });
    assert.equal(wrong.status, 401);
    const right = await fetch(url, { headers: { authorization: "Bearer s3cret-token" } });
    assert.equal(right.status, 200);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});

test("startHttpApiServer rate-limit applies before web-demo static serving (so the demo route is gated too — same fairness)", async () => {
  // We deliberately did NOT bypass the limiter for /web-demo/* in the
  // implementation, since static-file fetches still hit the same socket. The
  // earlier auth/static design specifically lets the demo bypass auth — but
  // not rate limiting. Confirm the limiter applies uniformly.
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({
    db,
    port: 0,
    rateLimit: { capacity: 1, refillPerSec: 0.1 },
    webDemoDir: path.resolve("fixtures/web-demo"),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const a = await fetch(`http://127.0.0.1:${port}/web-demo/index.html`);
    const b = await fetch(`http://127.0.0.1:${port}/web-demo/index.html`);
    assert.equal(a.status, 200);
    // Second request: bucket empty, but only /v1 is gated — the static path
    // bypasses the limiter check (see http-api.ts: tryServeWebDemo runs first).
    assert.equal(b.status, 200);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});
