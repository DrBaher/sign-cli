import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderPrometheusMetrics } from "../lib/prom-metrics.js";
import { startHttpApiServer } from "../lib/http-api.js";
import {
  createSigningRequest,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-prom-"));
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

test("renderPrometheusMetrics emits HELP/TYPE blocks for the core counters", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-prom-doc-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Prom test",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      signSigningRequest(db, { requestId: created.requestId, token: created.tokens[0].token });

      const out = renderPrometheusMetrics(db);
      // Required exposition headers.
      assert.match(out, /# HELP sign_cli_requests_total/);
      assert.match(out, /# TYPE sign_cli_requests_total gauge/);
      assert.match(out, /# TYPE sign_cli_audit_events_total counter/);
      assert.match(out, /# TYPE sign_cli_signer_actions_total counter/);
      assert.match(out, /# TYPE sign_cli_build_info gauge/);

      // Local provider with status=completed should have a row in requests_total.
      assert.match(out, /sign_cli_requests_total\{provider="local",status="completed"\} \d+/);
      // signed_by_signer event is recorded.
      assert.match(out, /sign_cli_audit_events_by_type\{event_type="request\.signed_by_signer"\} 1/);
      // Local sign action counter.
      assert.match(out, /sign_cli_signer_actions_total\{source="local",action="signed"\} 1/);
      // build_info has a version label.
      assert.match(out, /sign_cli_build_info\{version="\d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("HTTP /v1/metrics serves text/plain Prometheus format (not JSON)", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const server = startHttpApiServer({ db, port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/v1/metrics`);
      const text = await res.text();
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
      assert.match(text, /^# HELP sign_cli_requests_total/);
      // Make sure it's NOT a JSON envelope.
      assert.doesNotMatch(text, /^\{/);
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      db.close();
      cleanup();
    }
  });
});

test("/v1/metrics requires Bearer auth when --auth-token is set", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const server = startHttpApiServer({ db, port: 0, authToken: "shhh" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const noAuth = await fetch(`http://127.0.0.1:${port}/v1/metrics`);
      assert.equal(noAuth.status, 401);
      const ok = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
        headers: { authorization: "Bearer shhh" },
      });
      assert.equal(ok.status, 200);
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      db.close();
      cleanup();
    }
  });
});
