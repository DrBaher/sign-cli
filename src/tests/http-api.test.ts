import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listMockHttpRoutes, startHttpApiServer } from "../lib/http-api.js";
import {
  createSigningRequest,
  sendSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-http-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousAuto === undefined) delete process.env.SIGN_LOCAL_AUTOCOMPLETE;
    else process.env.SIGN_LOCAL_AUTOCOMPLETE = previousAuto;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return documentPath;
}

async function callJson(server: http.Server, route: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const [method, path] = route.split(" ", 2);
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("listMockHttpRoutes covers the core signer-side surface", () => {
  const routes = listMockHttpRoutes();
  for (const expected of [
    "GET /v1/health",
    "POST /v1/signer/list",
    "POST /v1/signer/fetch-document",
    "POST /v1/sign",
    "POST /v1/signer/decline",
    "POST /v1/request/show",
    "POST /v1/request/status",
    "POST /v1/audit/verify",
  ]) {
    assert.ok(routes.includes(expected), `missing route ${expected}`);
  }
});

test("HTTP /v1/health returns 200 + version", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const server = startHttpApiServer({ db, port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      const res = await callJson(server, "GET /v1/health", null);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.match(res.body.result.version, /^\d+\.\d+\.\d+/);
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      db.close();
      cleanup();
    }
  });
});

test("HTTP /v1/sign signs the request and round-trips through formatCliError on bad token", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-http-flow-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "HTTP test",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });

      const server = startHttpApiServer({ db, port: 0 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        // Wrong token → 400 with TOKEN_INVALID envelope
        const bad = await callJson(server, "POST /v1/sign", {
          request_id: created.requestId,
          token: "garbage",
        });
        assert.equal(bad.status, 400);
        assert.equal(bad.body.ok, false);
        assert.equal(bad.body.error.code, "TOKEN_INVALID");

        // Correct token → 200 with SignerSignResult
        const ok = await callJson(server, "POST /v1/sign", {
          request_id: created.requestId,
          token: created.tokens[0].token,
        });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.ok, true);
        assert.equal(ok.body.result.requestStatus, "completed");

        // Snapshot reflects the signature.
        const show = await callJson(server, "POST /v1/request/show", { request_id: created.requestId });
        assert.equal(show.body.result.signedBy.length, 1);
        assert.equal(show.body.result.signedBy[0].email, "alice@example.com");
      } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("HTTP server enforces Bearer auth when --auth-token is set", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const server = startHttpApiServer({ db, port: 0, authToken: "shhh" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      const noAuth = await callJson(server, "GET /v1/health", null);
      assert.equal(noAuth.status, 401);
      assert.equal(noAuth.body.error.code, "UNAUTHORIZED");

      const wrong = await callJson(server, "GET /v1/health", null, { authorization: "Bearer wrong" });
      assert.equal(wrong.status, 401);

      const right = await callJson(server, "GET /v1/health", null, { authorization: "Bearer shhh" });
      assert.equal(right.status, 200);
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      db.close();
      cleanup();
    }
  });
});

test("HTTP unknown route returns 404 with UNKNOWN_ROUTE", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const server = startHttpApiServer({ db, port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      const res = await callJson(server, "POST /v1/nope", {});
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "UNKNOWN_ROUTE");
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      db.close();
      cleanup();
    }
  });
});
