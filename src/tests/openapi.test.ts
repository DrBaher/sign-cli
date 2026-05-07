import test from "node:test";
import assert from "node:assert/strict";
import { buildOpenApiSpec } from "../lib/openapi.js";
import { startHttpApiServer } from "../lib/http-api.js";
import { createDb, makeTempDb } from "./helpers.js";

test("buildOpenApiSpec returns a 3.1.0 doc with the core route paths", () => {
  const spec = buildOpenApiSpec() as any;
  assert.equal(spec.openapi, "3.1.0");
  assert.equal(spec.info.title, "sign-cli HTTP API");
  assert.match(spec.info.version, /^\d+\.\d+\.\d+/);
  for (const path of [
    "/v1/health",
    "/v1/sign",
    "/v1/signer/list",
    "/v1/signer/fetch-document",
    "/v1/signer/decline",
    "/v1/request/show",
    "/v1/audit/verify",
  ]) {
    assert.ok(spec.paths[path], `expected path ${path} in OpenAPI spec`);
  }
});

test("buildOpenApiSpec marks required body fields and lists provider enums", () => {
  const spec = buildOpenApiSpec() as any;
  const sign = spec.paths["/v1/sign"].post.requestBody.content["application/json"].schema;
  assert.deepEqual(sign.required.sort(), ["request_id", "token"].sort());
  const status = spec.paths["/v1/request/status"].post.requestBody.content["application/json"].schema;
  assert.deepEqual(status.properties.provider.enum, ["dropbox", "docusign", "signwell", "local"]);
});

test("buildOpenApiSpec describes a Bearer security scheme", () => {
  const spec = buildOpenApiSpec() as any;
  assert.equal(spec.components.securitySchemes.bearer.type, "http");
  assert.equal(spec.components.securitySchemes.bearer.scheme, "bearer");
  assert.deepEqual(spec.security, [{ bearer: [] }]);
});

test("HTTP /v1/openapi.json serves the raw spec (no envelope wrap)", { concurrency: false }, async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({ db, port: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/v1/openapi.json`);
    const body = await res.json() as any;
    assert.equal(res.status, 200);
    assert.equal(body.openapi, "3.1.0", "openapi.json must return the raw spec, not { ok, result }");
    assert.ok(body.paths["/v1/sign"]);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
  }
});
