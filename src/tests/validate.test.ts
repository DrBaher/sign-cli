import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateBulkRowCount,
  validateDocumentPath,
  validateEmail,
  validateFieldCount,
  validateOutputPath,
  validateReturnUrl,
  validateSignerCount,
} from "../lib/validate.js";

test("validateOutputPath: rejects absolute path outside cwd without SIGN_ALLOW_ABSOLUTE_DOCS", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "out-traversal-"));
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  try {
    assert.throws(
      () => validateOutputPath("/etc/something.pdf", { cwd: dir }),
      /escapes the working directory/,
    );
    assert.throws(
      () => validateOutputPath("../../../escape.pdf", { cwd: dir }),
      /escapes the working directory/,
    );
    // Inside cwd → OK
    const resolved = validateOutputPath("inside.pdf", { cwd: dir });
    assert.equal(resolved, path.resolve(dir, "inside.pdf"));
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateOutputPath: SIGN_ALLOW_ABSOLUTE_DOCS=1 opts in to absolute paths", () => {
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  process.env.SIGN_ALLOW_ABSOLUTE_DOCS = "1";
  try {
    const resolved = validateOutputPath("/tmp/output.pdf", { cwd: "/var/tmp" });
    assert.equal(resolved, "/tmp/output.pdf", "should accept absolute path when opted in");
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
  }
});

test("validateEmail accepts simple addresses and rejects garbage", () => {
  validateEmail("a@b.co");
  validateEmail("alice+tag@example.com");
  assert.throws(() => validateEmail("notanemail"), /not a valid email/);
  assert.throws(() => validateEmail("missing@host"), /not a valid email/);
});

test("validateReturnUrl rejects file: javascript: data: and non-localhost http", () => {
  validateReturnUrl("https://example.com/return");
  validateReturnUrl("http://localhost:3000/return");
  validateReturnUrl("http://127.0.0.1/return");
  assert.throws(() => validateReturnUrl("javascript:alert(1)"), /not allowed/);
  assert.throws(() => validateReturnUrl("file:///etc/passwd"), /not allowed/);
  assert.throws(() => validateReturnUrl("data:text/html,oops"), /not allowed/);
  assert.throws(() => validateReturnUrl("http://evil.example.com/x"), /https/);
  assert.throws(() => validateReturnUrl("not-a-url"), /not a valid URL/);
});

test("validateDocumentPath rejects paths outside cwd unless overridden", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "doc-cwd-"));
  const insidePath = path.join(dir, "ok.pdf");
  writeFileSync(insidePath, "x");
  try {
    const inside = validateDocumentPath("ok.pdf", { cwd: dir });
    assert.equal(inside.resolved, insidePath);
    assert.throws(() => validateDocumentPath("../escape.pdf", { cwd: dir }), /escapes the working directory/);
    validateDocumentPath("ok.pdf", { cwd: dir, allowAbsoluteOutsideCwd: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateDocumentPath enforces SIGN_MAX_DOCUMENT_BYTES", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "doc-size-"));
  const bigPath = path.join(dir, "big.pdf");
  writeFileSync(bigPath, Buffer.alloc(2048));
  try {
    assert.throws(() => validateDocumentPath("big.pdf", { cwd: dir, maxBytes: 1024 }), /exceeding the limit/);
    validateDocumentPath("big.pdf", { cwd: dir, maxBytes: 4096 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("count validators enforce hard limits", () => {
  validateSignerCount(5);
  assert.throws(() => validateSignerCount(99, 50), /Too many signers/);
  validateFieldCount(0);
  assert.throws(() => validateFieldCount(500, 200), /Too many --field/);
  validateBulkRowCount(10);
  assert.throws(() => validateBulkRowCount(2000, 1000), /Too many CSV rows/);
});
