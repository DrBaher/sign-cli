import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  validateBulkRowCount,
  validateConfigPath,
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

test("validateReturnUrl enforces SIGN_RETURN_URL_ALLOWED_HOSTS when set", () => {
  const prev = process.env.SIGN_RETURN_URL_ALLOWED_HOSTS;
  process.env.SIGN_RETURN_URL_ALLOWED_HOSTS = "app.acme.com, portal.acme.com";
  try {
    // Allowed hosts pass; localhost always passes regardless of the list.
    validateReturnUrl("https://app.acme.com/done");
    validateReturnUrl("https://portal.acme.com/done");
    validateReturnUrl("http://localhost:3000/done");
    // A host not on the list is rejected even though it's https.
    assert.throws(() => validateReturnUrl("https://evil.example.com/x"), /not in SIGN_RETURN_URL_ALLOWED_HOSTS/);
  } finally {
    if (prev === undefined) delete process.env.SIGN_RETURN_URL_ALLOWED_HOSTS;
    else process.env.SIGN_RETURN_URL_ALLOWED_HOSTS = prev;
  }
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

test("validateConfigPath: expands ~ and ~/ under $HOME", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vcp-home-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "vcp-cwd-"));
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  try {
    assert.equal(validateConfigPath("~", { home, cwd }), path.resolve(home));
    assert.equal(validateConfigPath("~/.sign-cli/prod.db", { home, cwd }), path.resolve(home, ".sign-cli/prod.db"));
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("validateConfigPath: relative paths resolve under cwd without opt-in", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vcp-home2-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "vcp-cwd2-"));
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  try {
    assert.equal(validateConfigPath("project.db", { home, cwd }), path.resolve(cwd, "project.db"));
    assert.equal(validateConfigPath("./data/x.db", { home, cwd }), path.resolve(cwd, "data/x.db"));
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("validateConfigPath: rejects paths outside both $HOME and cwd without SIGN_ALLOW_ABSOLUTE_DOCS", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vcp-home3-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "vcp-cwd3-"));
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  try {
    assert.throws(
      () => validateConfigPath("/etc/sign.db", { home, cwd }),
      /outside both \$HOME .* and CWD/,
    );
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("validateConfigPath: SIGN_ALLOW_ABSOLUTE_DOCS=1 opts in to arbitrary absolute paths", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vcp-home4-"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "vcp-cwd4-"));
  const saved = process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
  process.env.SIGN_ALLOW_ABSOLUTE_DOCS = "1";
  try {
    assert.equal(validateConfigPath("/etc/sign.db", { home, cwd }), "/etc/sign.db");
  } finally {
    if (saved === undefined) delete process.env.SIGN_ALLOW_ABSOLUTE_DOCS;
    else process.env.SIGN_ALLOW_ABSOLUTE_DOCS = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
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
