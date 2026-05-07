import test from "node:test";
import assert from "node:assert/strict";
import { renderReceiptVerificationHtml } from "../lib/receipt-html.js";
import type { ReceiptVerificationResult } from "../lib/receipt-verify.js";

const PASSING: ReceiptVerificationResult = {
  ok: true,
  bundleDir: "/tmp/receipt",
  manifestVerified: true,
  manifestSha256: "ab".repeat(32),
  signerSubject: "CN=Sign CLI Local Signer, O=Sign CLI Local Provider",
  files: [
    { name: "audit.json", expected: "1".repeat(64), actual: "1".repeat(64), ok: true },
    { name: "signed.pdf", expected: "2".repeat(64), actual: "2".repeat(64), ok: true },
  ],
  chain: { events: 7, ok: true, break: null },
  errors: [],
};

const FAILING: ReceiptVerificationResult = {
  ok: false,
  bundleDir: "/tmp/receipt",
  manifestVerified: false,
  manifestSha256: "ff".repeat(32),
  signerSubject: null,
  files: [
    { name: "signed.pdf", expected: "2".repeat(64), actual: "3".repeat(64), ok: false },
  ],
  chain: { events: 5, ok: false, break: { kind: "hash_self_mismatch", eventId: 3, expected: null, actual: "x" } },
  errors: ["Signature does not verify against manifest.json with the embedded cert."],
};

test("renderReceiptVerificationHtml emits a <!doctype html> document with the verdict in the title bar", () => {
  const html = renderReceiptVerificationHtml(PASSING);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Sign CLI receipt verification<\/title>/);
  assert.match(html, /VERIFIED/);
  assert.match(html, /CN=Sign CLI Local Signer/);
});

test("renderReceiptVerificationHtml renders FAILED for a broken bundle and lists errors", () => {
  const html = renderReceiptVerificationHtml(FAILING);
  assert.match(html, /FAILED/);
  assert.match(html, /MISMATCH/);
  assert.match(html, /Signature does not verify/);
  assert.match(html, /hash_self_mismatch at event 3/);
});

test("renderReceiptVerificationHtml escapes HTML metacharacters in injected fields", () => {
  const html = renderReceiptVerificationHtml({
    ...PASSING,
    bundleDir: "/tmp/<script>alert(1)</script>",
    signerSubject: 'CN="<img src=x onerror=alert(1)>"',
    errors: ["<bad>"],
    ok: false,
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror/);
});

test("renderReceiptVerificationHtml lists each manifest file with both expected + actual hashes", () => {
  const html = renderReceiptVerificationHtml(PASSING);
  for (const f of PASSING.files) {
    assert.ok(html.includes(f.name), `expected file ${f.name} in HTML`);
    assert.ok(html.includes(f.expected), `expected hash for ${f.name} in HTML`);
  }
});
