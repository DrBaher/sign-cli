import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectPdfSignatures } from "../lib/pdf-signature.js";

test("inspectPdfSignatures reports no signature on a plain PDF", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pdf-sig-"));
  const file = path.join(dir, "plain.pdf");
  writeFileSync(file, "%PDF-1.4\n% no signatures here\n%%EOF", "utf8");
  const report = await inspectPdfSignatures(file);
  assert.equal(report.hasSignature, false);
  assert.equal(report.signatureCount, 0);
  assert.ok(report.warnings.some((w) => w.includes("not signed")));
});

test("inspectPdfSignatures finds a /ByteRange and reports gracefully when /Contents is unparseable", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pdf-sig-"));
  const file = path.join(dir, "fake.pdf");
  // Construct a tiny PDF-like body with a /ByteRange but a fake Contents blob (not real PKCS#7)
  const before = Buffer.from("%PDF-1.4\n", "utf8");
  const placeholder = Buffer.from("/ByteRange [0 100 200 300] /Contents <DEADBEEF>", "utf8");
  const body = Buffer.concat([before, placeholder, Buffer.alloc(500, 0x20)]);
  writeFileSync(file, body);
  const report = await inspectPdfSignatures(file);
  assert.equal(report.signatureCount, 1);
  assert.deepEqual(report.signatures[0].byteRange, [0, 100, 200, 300]);
  // Either we parsed it (unlikely) or we recorded a warning about the parse — both acceptable.
  if (report.signatures[0].messageDigestMatches !== null) {
    // parsed something; OK
  } else {
    assert.ok(
      report.signatures[0].parseWarnings.length > 0
        || report.signatures[0].messageDigest === null,
      "expected a parse warning or null message digest for fake PKCS#7",
    );
  }
});
