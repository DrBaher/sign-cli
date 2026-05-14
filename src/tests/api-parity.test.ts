// Parity tests for the new HTTP routes + new MCP tools added to bring the
// two surfaces in sync. The handlers are thin wrappers over the same lib
// functions covered by other tests (signing-service.ts is exhaustively
// tested) — these tests verify wiring: routes registered, schemas loaded,
// read-only blocking applies, validation runs.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listMockHttpRoutes, READ_ONLY_BLOCKED_ROUTES, startHttpApiServer } from "../lib/http-api.js";
import { dispatchMcp, listMcpTools, READ_ONLY_BLOCKED_TOOLS } from "../lib/mcp-server.js";
import { createDb, makeTempDb } from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PDF = path.resolve(__dirname, "../../fixtures/canonical-unsigned-v1.pdf");

async function callJson(server: http.Server, route: string, body: unknown): Promise<{ status: number; body: any }> {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const [method, p] = route.split(" ", 2);
  const response = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// ─── HTTP route parity ──────────────────────────────────────────────────

test("listMockHttpRoutes registers the 7 new parity routes", () => {
  const routes = listMockHttpRoutes();
  for (const expected of [
    "POST /v1/pdf/detect-signature-field",
    "POST /v1/pdf/detect-date-field",
    "POST /v1/pdf/stamp-text",
    "POST /v1/preview",
    "POST /v1/document",
    "POST /v1/profile/list",
    "POST /v1/profile/show",
  ]) {
    assert.ok(routes.includes(expected), `missing route ${expected}`);
  }
});

test("READ_ONLY_BLOCKED_ROUTES covers the 3 new mutating routes", () => {
  for (const expected of ["POST /v1/pdf/stamp-text", "POST /v1/preview", "POST /v1/document"]) {
    assert.ok(READ_ONLY_BLOCKED_ROUTES.has(expected), `${expected} should be in READ_ONLY_BLOCKED_ROUTES`);
  }
});

test("HTTP /v1/pdf/detect-signature-field returns candidates", { concurrency: false }, async () => {
  if (!existsSync(FIXTURE_PDF)) return;
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  process.env.SIGN_ALLOW_ABSOLUTE_DOCS = "1";
  try {
    const server = startHttpApiServer({ db, port: 0 });
    await new Promise((res) => setTimeout(res, 10));
    try {
      const r = await callJson(server, "POST /v1/pdf/detect-signature-field", { pdf_path: FIXTURE_PDF });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(typeof r.body.result.pageCount, "number");
      assert.ok(Array.isArray(r.body.result.candidates));
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
    db.close();
    cleanup();
  }
});

test("HTTP /v1/preview blocked under --read-only true", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const server = startHttpApiServer({ db, port: 0, readOnly: true });
    await new Promise((res) => setTimeout(res, 10));
    try {
      const r = await callJson(server, "POST /v1/preview", { pdf_path: "x.pdf", out_path: "o.pdf" });
      assert.equal(r.status, 403);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.error.code, "FORBIDDEN_READ_ONLY");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  } finally {
    db.close();
    cleanup();
  }
});

test("HTTP /v1/profile/list returns the user file location + active source", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "http-profile-list-"));
  const previousProfilesFile = process.env.SIGN_PROFILES_FILE;
  process.env.SIGN_PROFILES_FILE = path.join(dir, "profiles.json"); // missing
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const server = startHttpApiServer({ db, port: 0 });
    await new Promise((res) => setTimeout(res, 10));
    try {
      const r = await callJson(server, "POST /v1/profile/list", {});
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(typeof r.body.result.userFilePath, "string");
      assert.deepEqual(r.body.result.profiles, []);
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  } finally {
    db.close();
    cleanup();
    if (previousProfilesFile === undefined) delete process.env.SIGN_PROFILES_FILE;
    else process.env.SIGN_PROFILES_FILE = previousProfilesFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP /v1/profile/show by name redacts credentials by default", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "http-profile-show-"));
  const profilesPath = path.join(dir, "profiles.json");
  writeFileSync(profilesPath, JSON.stringify({
    version: 1,
    defaultProfile: "main",
    profiles: { main: { version: 1, provider: "dropbox", credentials: { DROPBOX_SIGN_API_KEY: "supersecret-shhh" } } },
  }, null, 2));
  const previousProfilesFile = process.env.SIGN_PROFILES_FILE;
  process.env.SIGN_PROFILES_FILE = profilesPath;
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const server = startHttpApiServer({ db, port: 0 });
    await new Promise((res) => setTimeout(res, 10));
    try {
      const r = await callJson(server, "POST /v1/profile/show", { name: "main" });
      assert.equal(r.status, 200);
      assert.ok(!JSON.stringify(r.body).includes("supersecret-shhh"), "secret leaked when show_secrets=false");
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  } finally {
    db.close();
    cleanup();
    if (previousProfilesFile === undefined) delete process.env.SIGN_PROFILES_FILE;
    else process.env.SIGN_PROFILES_FILE = previousProfilesFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── MCP tool parity ────────────────────────────────────────────────────

test("listMcpTools includes signer_reissue_token, audit_scan, request_receipt", () => {
  const names = listMcpTools().map((t) => t.name);
  for (const expected of ["signer_reissue_token", "audit_scan", "request_receipt"]) {
    assert.ok(names.includes(expected), `missing MCP tool ${expected}`);
  }
});

test("READ_ONLY_BLOCKED_TOOLS gates signer_reissue_token + request_receipt; audit_scan stays open", () => {
  assert.ok(READ_ONLY_BLOCKED_TOOLS.has("signer_reissue_token"));
  assert.ok(READ_ONLY_BLOCKED_TOOLS.has("request_receipt"));
  assert.ok(!READ_ONLY_BLOCKED_TOOLS.has("audit_scan"), "audit_scan is read-only — should not be blocked");
});

test("MCP audit_scan returns the report shape (zero rows in an empty DB)", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "audit_scan", arguments: {} },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.notEqual(value.isError, true);
    const report = JSON.parse(value.content[0].text);
    assert.equal(report.total, 0);
    assert.equal(report.valid, 0);
    assert.equal(report.invalid, 0);
    assert.deepEqual(report.results, []);
  } finally {
    db.close();
    cleanup();
  }
});

test("MCP request_receipt rejects out_dir traversal without SIGN_ALLOW_ABSOLUTE_DOCS", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  try {
    const dispatch = await dispatchMcp({
      method: "tools/call",
      params: { name: "request_receipt", arguments: { request_id: "anything", out_dir: "/etc/sign-receipts" } },
      db,
    });
    const value = (dispatch as { kind: "result"; value: any }).value;
    assert.equal(value.isError, true);
    const envelope = JSON.parse(value.content[0].text);
    assert.match(envelope.error.message, /escapes the working directory/);
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
    db.close();
    cleanup();
  }
});

test("MCP signer_reissue_token + request_receipt blocked under --read-only true", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    for (const tool of ["signer_reissue_token", "request_receipt"] as const) {
      const args: Record<string, string> = tool === "signer_reissue_token"
        ? { request_id: "x", signer_email: "a@b.co" }
        : { request_id: "x", out_dir: "out" };
      const dispatch = await dispatchMcp({
        method: "tools/call",
        params: { name: tool, arguments: args },
        db,
        readOnly: true,
      });
      const value = (dispatch as { kind: "result"; value: any }).value;
      assert.equal(value.isError, true, `${tool} should be blocked`);
      const envelope = JSON.parse(value.content[0].text);
      assert.equal(envelope.error.code, "FORBIDDEN_READ_ONLY");
    }
  } finally {
    db.close();
    cleanup();
  }
});

// ─── OpenAPI spec parity ────────────────────────────────────────────────

test("buildOpenApiSpec includes the 7 new HTTP routes", async () => {
  const { buildOpenApiSpec } = await import("../lib/openapi.js");
  const spec = buildOpenApiSpec() as { paths: Record<string, unknown> };
  for (const expected of [
    "/v1/pdf/detect-signature-field",
    "/v1/pdf/detect-date-field",
    "/v1/pdf/stamp-text",
    "/v1/preview",
    "/v1/document",
    "/v1/profile/list",
    "/v1/profile/show",
  ]) {
    assert.ok(spec.paths[expected], `OpenAPI missing path ${expected}`);
  }
});
