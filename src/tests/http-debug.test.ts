import test from "node:test";
import assert from "node:assert/strict";
import { retryFetch } from "../lib/http.js";

test("retryFetch with debugSink emits redacted request/response lines", async () => {
  const lines: string[] = [];
  await retryFetch("https://example.test/x", {
    method: "POST",
    headers: { Authorization: "Basic supersecret_value", Accept: "application/json" },
    body: "ignored",
  }, {
    fetchImpl: (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as any,
    sleep: async () => undefined,
    maxRetries: 0,
    debugSink: (line) => lines.push(line),
  });
  const requestLine = lines.find((line) => line.includes("[http] ->"));
  const responseLine = lines.find((line) => line.includes("[http] <-"));
  assert.ok(requestLine);
  assert.ok(responseLine);
  assert.ok(!requestLine!.includes("supersecret_value"));
  assert.match(requestLine!, /Authorization/);
  assert.match(requestLine!, /Bas\*\*\*ue/);
});

test("retryFetch debugSink logs retry attempts before final response", async () => {
  const lines: string[] = [];
  let calls = 0;
  await retryFetch("https://example.test/x", undefined, {
    fetchImpl: (async () => {
      calls += 1;
      if (calls < 3) return new Response("down", { status: 503 });
      return new Response("ok", { status: 200 });
    }) as any,
    sleep: async () => undefined,
    baseDelayMs: 1,
    maxRetries: 3,
    debugSink: (line) => lines.push(line),
  });
  const retryLines = lines.filter((line) => line.includes("[http] retry"));
  assert.equal(retryLines.length, 2);
  assert.ok(lines.find((line) => line.includes("[http] <- 200")));
});
