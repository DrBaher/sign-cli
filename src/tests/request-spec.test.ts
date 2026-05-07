import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRequestSpec, parseRequestSpec } from "../lib/request-spec.js";
import { SignCliError } from "../lib/sign-error.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return documentPath;
}

test("parseRequestSpec accepts a minimal valid object", () => {
  const spec = parseRequestSpec({
    title: "Spec test",
    documentPath: "./doc.pdf",
    signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
  });
  assert.equal(spec.title, "Spec test");
  assert.equal(spec.documentPath, "./doc.pdf");
  assert.equal(spec.signers.length, 1);
});

test("parseRequestSpec accepts multi-document, fields, prefills, provider, autoApprove", () => {
  const spec = parseRequestSpec({
    title: "Full spec",
    documentPaths: ["./a.pdf", "./b.pdf"],
    signers: [
      { name: "Alice", email: "alice@example.com", order: 1 },
      { name: "Bob", email: "bob@example.com", order: 2, role: "Buyer" },
    ],
    fields: [{ signerOrder: 1, documentIndex: 0, page: 1, x: 50, y: 50, type: "signature" }],
    prefills: [{ name: "purchase_price", value: "1000", signerOrder: 2 }],
    tokenTtlMinutes: 90,
    provider: "local",
    autoApprove: true,
  });
  assert.equal(spec.documentPaths?.length, 2);
  assert.equal(spec.fields?.length, 1);
  assert.equal(spec.prefills?.length, 1);
  assert.equal(spec.tokenTtlMinutes, 90);
  assert.equal(spec.provider, "local");
  assert.equal(spec.autoApprove, true);
});

test("parseRequestSpec rejects mixing templateId with document paths", () => {
  assert.throws(
    () =>
      parseRequestSpec({
        title: "Bad",
        templateId: "tmpl_abc",
        documentPath: "./doc.pdf",
        signers: [{ name: "Alice", email: "alice@example.com", order: 1, role: "Buyer" }],
      }),
    (err: unknown) => err instanceof SignCliError && err.code === "INVALID_SPEC",
  );
});

test("parseRequestSpec rejects when no document or template is provided", () => {
  assert.throws(
    () =>
      parseRequestSpec({
        title: "Bad",
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      }),
    (err: unknown) => err instanceof SignCliError && err.code === "INVALID_SPEC",
  );
});

test("parseRequestSpec rejects malformed signers entries", () => {
  assert.throws(
    () =>
      parseRequestSpec({
        title: "Bad",
        documentPath: "./doc.pdf",
        signers: [{ name: "Alice", email: "alice@example.com", order: 0 }],
      }),
    (err: unknown) => err instanceof SignCliError && err.code === "INVALID_SPEC",
  );
});

test("loadRequestSpec round-trips a real JSON file into createSigningRequest", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-spec-load-"));
  const documentPath = makeFixturePdf(dir);
  const specPath = path.join(dir, "request.json");
  writeFileSync(specPath, JSON.stringify({
    title: "Round trip",
    documentPath,
    signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    tokenTtlMinutes: 30,
    provider: "local",
    autoApprove: true,
  }, null, 2));

  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  try {
    const spec = loadRequestSpec(specPath);
    const created = createSigningRequest(db, {
      title: spec.title,
      documentPath: spec.documentPath,
      signers: spec.signers,
      tokenTtlMinutes: spec.tokenTtlMinutes ?? 30,
      provider: spec.provider,
      autoApprove: spec.autoApprove,
    });
    assert.match(created.requestId, /^req_/);
    assert.equal(created.tokens.length, 1);
  } finally {
    db.close();
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRequestSpec throws INVALID_SPEC for missing files and non-JSON content", () => {
  assert.throws(
    () => loadRequestSpec("/this/path/does/not/exist.json"),
    (err: unknown) => err instanceof SignCliError && err.code === "INVALID_SPEC",
  );
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-spec-bad-"));
  const badPath = path.join(dir, "bad.json");
  writeFileSync(badPath, "not-json", "utf8");
  try {
    assert.throws(
      () => loadRequestSpec(badPath),
      (err: unknown) => err instanceof SignCliError && err.code === "INVALID_SPEC",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
