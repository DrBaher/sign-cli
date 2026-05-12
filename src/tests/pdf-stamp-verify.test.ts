import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { canonicalUnsignedPdfPath } from "../lib/fixtures.js";
import { stampImageOnPdf, parseImageInput } from "../lib/pdf-image-stamp.js";
import { verifyPdfStamp, stampVerifyExitCode } from "../lib/pdf-stamp-verify.js";

// 1×1 transparent PNG, base64.
const TINY_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const TINY_IMAGE = parseImageInput(TINY_PNG_DATA_URL);

async function stampedFixture(position = { page: 1, x: 100, y: 200, width: 150, height: 60 }): Promise<Buffer> {
  const pdf = readFileSync(canonicalUnsignedPdfPath());
  return stampImageOnPdf(pdf, TINY_IMAGE, position);
}

test("stampVerifyExitCode: ok→0, wrong_position→3, missing→4", () => {
  assert.equal(stampVerifyExitCode("ok"), 0);
  assert.equal(stampVerifyExitCode("wrong_position"), 3);
  assert.equal(stampVerifyExitCode("missing"), 4);
});

test("verifyPdfStamp: round-trip — stampImageOnPdf then verify with same position → verdict=ok", async () => {
  const expected = { page: 1, x: 100, y: 200, width: 150, height: 60 };
  const stamped = await stampedFixture(expected);
  const report = await verifyPdfStamp(stamped, expected);
  assert.equal(report.verdict, "ok", `expected ok, got ${JSON.stringify(report)}`);
  assert.ok(report.found, "found should be populated");
  assert.equal(report.found?.page, 1);
  assert.ok(Math.abs((report.found?.x ?? 0) - 100) <= 1);
});

test("verifyPdfStamp: unsigned (unstamped) PDF → verdict=missing", async () => {
  const pdf = readFileSync(canonicalUnsignedPdfPath());
  const report = await verifyPdfStamp(pdf, { page: 1, x: 100, y: 200, width: 150, height: 60 });
  assert.equal(report.verdict, "missing");
  assert.equal(report.found, null);
  assert.equal(report.candidates.length, 0);
});

test("verifyPdfStamp: wrong page → verdict=missing with out-of-range detail", async () => {
  const stamped = await stampedFixture();
  const report = await verifyPdfStamp(stamped, { page: 5, x: 100, y: 200, width: 150, height: 60 });
  assert.equal(report.verdict, "missing");
  assert.match(report.detail, /out of range/);
});

test("verifyPdfStamp: stamp present but at the wrong position → verdict=wrong_position with the actual position reported as `found`", async () => {
  const stamped = await stampedFixture({ page: 1, x: 100, y: 200, width: 150, height: 60 });
  const report = await verifyPdfStamp(stamped, { page: 1, x: 400, y: 500, width: 150, height: 60 });
  assert.equal(report.verdict, "wrong_position");
  assert.ok(report.found, "the wrong-position case should still surface the closest candidate");
  assert.equal(Math.round(report.found!.x), 100, "found.x should be the actual stamp position, not the expected");
  assert.equal(Math.round(report.found!.y), 200);
  assert.match(report.detail, /Closest: x=100/);
});

test("verifyPdfStamp: ±1pt tolerance — sub-pixel drift still matches", async () => {
  const stamped = await stampedFixture({ page: 1, x: 100, y: 200, width: 150, height: 60 });
  // Expected within tolerance: 100.5pt off → should still be ok
  const report = await verifyPdfStamp(stamped, { page: 1, x: 100.5, y: 199.7, width: 150.2, height: 60.3 });
  assert.equal(report.verdict, "ok");
});

test("verifyPdfStamp: 2pt drift exceeds tolerance → wrong_position", async () => {
  const stamped = await stampedFixture({ page: 1, x: 100, y: 200, width: 150, height: 60 });
  const report = await verifyPdfStamp(stamped, { page: 1, x: 103, y: 200, width: 150, height: 60 });
  assert.equal(report.verdict, "wrong_position");
});

test("verifyPdfStamp: invalid page index (zero or negative) → throws", async () => {
  const stamped = await stampedFixture();
  await assert.rejects(
    () => verifyPdfStamp(stamped, { page: 0, x: 100, y: 200, width: 150, height: 60 }),
    /1-indexed/,
  );
});

test("verifyPdfStamp: multi-stamp PDF — verify finds the matching one even with other stamps present", async () => {
  // Stamp once at (100, 200), then re-stamp the result at (300, 400).
  const once = await stampedFixture({ page: 1, x: 100, y: 200, width: 150, height: 60 });
  const twice = await stampImageOnPdf(once, TINY_IMAGE, { page: 1, x: 300, y: 400, width: 80, height: 40 });
  const r1 = await verifyPdfStamp(twice, { page: 1, x: 100, y: 200, width: 150, height: 60 });
  const r2 = await verifyPdfStamp(twice, { page: 1, x: 300, y: 400, width: 80, height: 40 });
  assert.equal(r1.verdict, "ok");
  assert.equal(r2.verdict, "ok");
  assert.ok(r1.candidates.length >= 2, "candidates should include both stamps");
});

test("verifyPdfStamp: canonical fixture (Item 4) is a valid input — proves the fixture/verify pair works together", async () => {
  // The canonical fixture has no stamps; the verifier should correctly say "missing".
  const pdf = readFileSync(canonicalUnsignedPdfPath());
  const report = await verifyPdfStamp(pdf, { page: 1, x: 100, y: 200, width: 150, height: 60 });
  assert.equal(report.verdict, "missing");
});
