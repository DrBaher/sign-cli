import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { READ_ONLY_BLOCKED_ROUTES, startHttpApiServer } from "../lib/http-api.js";
import { createDb, makeTempDb } from "./helpers.js";

async function fetchPath(server: http.Server, urlPath: string, init: RequestInit = {}): Promise<Response> {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return fetch(`http://127.0.0.1:${port}${urlPath}`, init);
}

test("READ_ONLY_BLOCKED_ROUTES covers every lifecycle-mutating endpoint", () => {
  assert.deepEqual(
    [...READ_ONLY_BLOCKED_ROUTES].sort(),
    [
      "POST /v1/document",
      "POST /v1/pdf/stamp-text",
      "POST /v1/preview",
      "POST /v1/request/receipt",
      "POST /v1/sign",
      "POST /v1/signer/decline",
      "POST /v1/signer/reissue-token",
    ],
  );
});

test("startHttpApiServer with --read-only true returns 403 FORBIDDEN_READ_ONLY for mutating routes", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({ db, port: 0, readOnly: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const res = await fetchPath(server, "/v1/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "x", token: "y" }),
    });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.equal(json.error.code, "FORBIDDEN_READ_ONLY");
    assert.match(json.error.message, /POST \/v1\/sign/);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});

test("startHttpApiServer with --read-only true still allows read endpoints (health, signer/list, audit/scan)", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({ db, port: 0, readOnly: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const health = await fetchPath(server, "/v1/health");
    assert.equal(health.status, 200);
    const list = await fetchPath(server, "/v1/signer/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(list.status, 200);
    const scan = await fetchPath(server, "/v1/audit/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(scan.status, 200);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});

test("without --read-only, mutating routes don't return 403 FORBIDDEN_READ_ONLY", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({ db, port: 0 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const res = await fetchPath(server, "/v1/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "x", token: "y" }),
    });
    // The actual handler will fail with REQUEST_NOT_FOUND or similar, but it
    // should NOT be the FORBIDDEN_READ_ONLY 403 envelope.
    if (res.status === 403) {
      const json = await res.json();
      assert.notEqual(json.error?.code, "FORBIDDEN_READ_ONLY");
    }
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});
