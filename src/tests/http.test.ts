import test from "node:test";
import assert from "node:assert/strict";
import { retryFetch } from "../lib/http.js";

function jsonResponse(status: number, body: any, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("retryFetch returns success without retry", async () => {
  let calls = 0;
  const response = await retryFetch("https://x.test", undefined, {
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse(200, { ok: true });
    }) as any,
    sleep: async () => undefined,
    maxRetries: 3,
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test("retryFetch retries on 503 then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const response = await retryFetch("https://x.test", undefined, {
    fetchImpl: (async () => {
      calls += 1;
      if (calls < 3) return jsonResponse(503, { err: "down" });
      return jsonResponse(200, { ok: true });
    }) as any,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 10,
    maxRetries: 3,
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test("retryFetch honors Retry-After header on 429", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await retryFetch("https://x.test", undefined, {
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(429, { err: "slow" }, { "retry-after": "2" });
      }
      return jsonResponse(200, { ok: true });
    }) as any,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 9999,
    maxRetries: 3,
  });
  assert.deepEqual(sleeps, [2000]);
});

test("retryFetch gives up after maxRetries and returns last response", async () => {
  let calls = 0;
  const response = await retryFetch("https://x.test", undefined, {
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse(503, { err: "down" });
    }) as any,
    sleep: async () => undefined,
    baseDelayMs: 1,
    maxRetries: 2,
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 3);
});

test("retryFetch retries on network error and propagates if exhausted", async () => {
  let calls = 0;
  await assert.rejects(() => retryFetch("https://x.test", undefined, {
    fetchImpl: (async () => {
      calls += 1;
      throw new Error("connect refused");
    }) as any,
    sleep: async () => undefined,
    baseDelayMs: 1,
    maxRetries: 1,
  }), /connect refused/);
  assert.equal(calls, 2);
});

test("retryFetch does not retry 4xx other than 408/425/429", async () => {
  let calls = 0;
  const response = await retryFetch("https://x.test", undefined, {
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse(400, { err: "bad" });
    }) as any,
    sleep: async () => undefined,
    maxRetries: 3,
  });
  assert.equal(response.status, 400);
  assert.equal(calls, 1);
});
