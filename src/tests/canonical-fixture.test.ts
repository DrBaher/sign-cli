import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { canonicalUnsignedPdfPath, CANONICAL_UNSIGNED_PDF_FIXTURE } from "../lib/fixtures.js";

test("canonical fixture exists on disk at the helper-resolved path", () => {
  const p = canonicalUnsignedPdfPath();
  assert.ok(existsSync(p), `expected fixture at ${p}`);
  assert.ok(p.endsWith(CANONICAL_UNSIGNED_PDF_FIXTURE), `path should end with versioned filename: ${p}`);
});

test("canonical fixture is a valid PDF that pdf-lib can load", async () => {
  // This is the whole point of the fixture — it's stamp-ready, not the
  // hand-rolled "%PDF-1.4\n%%EOF" placeholder that pdf-lib refuses.
  const bytes = readFileSync(canonicalUnsignedPdfPath());
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPages();
  assert.equal(pages.length, 1, "fixture should have exactly one page");
  // Letter size: 612×792 pt.
  assert.equal(Math.round(pages[0].getWidth()), 612);
  assert.equal(Math.round(pages[0].getHeight()), 792);
});

test("canonical fixture has stable byte size (deterministic generation)", () => {
  // If pdf-lib's output format changes, this test will fail and the
  // generator script needs to be rerun + the new file committed. The size
  // assertion is intentionally exact so silent regressions are caught.
  const size = statSync(canonicalUnsignedPdfPath()).size;
  assert.equal(size, 2084, `unexpected fixture size: ${size}. Regenerate via scripts/generate-canonical-unsigned-pdf.ts and update this assertion.`);
});

test("canonical fixture carries no embedded signatures (sanity)", async () => {
  // It's supposed to be UNSIGNED. If something accidentally re-stamps the
  // file, signed-PDF verify tests downstream would silently change behavior.
  const bytes = readFileSync(canonicalUnsignedPdfPath());
  // Look for a /Sig entry or a /ByteRange — the two telltale markers.
  const asString = bytes.toString("latin1");
  assert.equal(asString.includes("/ByteRange"), false, "fixture must not contain /ByteRange (would mean it's signed)");
  assert.equal(asString.includes("/Type /Sig"), false, "fixture must not contain /Type /Sig");
});
