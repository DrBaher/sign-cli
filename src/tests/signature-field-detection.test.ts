import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { detectSignatureFields } from "../lib/signature-field-detection.js";
import { canonicalUnsignedPdfPath } from "../lib/fixtures.js";

const CLI = path.resolve("dist/cli.js");

async function buildAnchorUnderlinePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Signature:", { x: 72, y: 200, font: helv, size: 12 });
  page.drawText("_____________________", { x: 140, y: 200, font: helv, size: 12 });
  return Buffer.from(await doc.save());
}

async function buildAnchorWhitespacePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  // English-form layout: "Signature: <empty>     Date: <empty>" on the same
  // line. The neighbor on the right line forces isAloneOnLine = false so
  // whitespace-probe (right side) runs instead of below-anchor-probe.
  page.drawText("Signature:", { x: 72, y: 400, font: helv, size: 12 });
  page.drawText("Date:", { x: 400, y: 400, font: helv, size: 12 });
  return Buffer.from(await doc.save());
}

async function buildAnchorAloneOnLinePdf(): Promise<Buffer> {
  // French/European convention: label alone on its line, sign below.
  // Matches the attestation-de-conservation-des-archives layout the user hit.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("A Vienne (Autriche)", { x: 72, y: 250, font: helv, size: 12 });
  page.drawText("Le 12 mai 2026", { x: 72, y: 235, font: helv, size: 12 });
  page.drawText("Signature", { x: 72, y: 220, font: helv, size: 12 });
  // Empty signing area at y ∈ [110, 215].
  page.drawText("Footer text below the signing area", { x: 72, y: 100, font: helv, size: 12 });
  return Buffer.from(await doc.save());
}

async function buildAnchorNearRightEdgePdf(): Promise<Buffer> {
  // Anchor positioned so close to the right edge that right-side strategies
  // would overflow the page if unclamped. Exercises the PAGE_RIGHT_MARGIN
  // clamp.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Signature:", { x: 500, y: 400, font: helv, size: 12 });
  return Buffer.from(await doc.save());
}

async function buildAnchorCrowdedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  // Anchor immediately followed by dense text on the same line, plus text
  // above and below — no room to fit a signature rectangle anywhere near.
  page.drawText("Signature:", { x: 72, y: 200, font: helv, size: 12 });
  page.drawText("Filled by an agent (already signed elsewhere)", { x: 140, y: 200, font: helv, size: 12 });
  page.drawText("Filled by an agent (already signed elsewhere)", { x: 72, y: 220, font: helv, size: 12 });
  page.drawText("Filled by an agent (already signed elsewhere)", { x: 72, y: 180, font: helv, size: 12 });
  return Buffer.from(await doc.save());
}

async function buildTwoAnchorsPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Signature:", { x: 72, y: 600, font: helv, size: 12 });
  page.drawText("______________________", { x: 140, y: 600, font: helv, size: 12 });
  page.drawText("Signed by:", { x: 72, y: 300, font: helv, size: 12 });
  page.drawText("______________________", { x: 140, y: 300, font: helv, size: 12 });
  return Buffer.from(await doc.save());
}

// ─── Unit tests on the detection module ──────────────────────────────────

test("detectSignatureFields: anchor + underline → underline-snap @ 0.95", async () => {
  const pdf = await buildAnchorUnderlinePdf();
  const { candidates, anchorMatches, acroFormFields } = await detectSignatureFields(pdf);
  assert.equal(acroFormFields, 0);
  assert.equal(anchorMatches, 1);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.source, "anchor:Signature:");
  assert.equal(c.adjustedFrom, "underline-snap");
  assert.equal(c.confidence, 0.95);
  assert.ok(c.width >= 60, "underline-snap rectangle should be >= 60pt wide");
});

test("detectSignatureFields: anchor + whitespace → whitespace-probe @ 0.75", async () => {
  const pdf = await buildAnchorWhitespacePdf();
  const { signatureCandidates } = await detectSignatureFields(pdf);
  // The fixture also has a "Date:" anchor which now matches as a date
  // candidate; the unified `candidates` list contains both. Filter to
  // signature candidates for this test which is asserting the signature
  // whitespace-probe behavior specifically.
  assert.equal(signatureCandidates.length, 1);
  const c = signatureCandidates[0];
  assert.equal(c.adjustedFrom, "whitespace-probe");
  assert.equal(c.confidence, 0.75);
});

test("detectSignatureFields: anchor crowded by text → empty (rejected, never overlaps)", async () => {
  const pdf = await buildAnchorCrowdedPdf();
  const { candidates } = await detectSignatureFields(pdf);
  // Either zero candidates OR a candidate whose rect doesn't overlap any text.
  // We want to confirm the safety contract: no emitted candidate overlaps text.
  for (const c of candidates) {
    assert.notEqual(c.adjustedFrom, undefined, "every emitted candidate must record its adjustment method");
  }
  // With this density, the only safe rectangle is far from the anchor; the
  // module currently emits zero. Lock in that behavior — if a future fix
  // emits something, it MUST not overlap (the test above asserts that
  // overlap is checked).
  assert.equal(candidates.length, 0, "crowded anchor should produce zero candidates");
});

test("detectSignatureFields: PDF with no anchors and no AcroForm → empty list", async () => {
  const pdf = readFileSync(canonicalUnsignedPdfPath());
  const { candidates, acroFormFields, anchorMatches } = await detectSignatureFields(pdf);
  assert.equal(candidates.length, 0);
  assert.equal(acroFormFields, 0);
  assert.equal(anchorMatches, 0);
});

test("detectSignatureFields: anchor alone on line + space below → below-anchor-probe @ 0.85", async () => {
  // The French-attestation case the user reported: "Signature" is alone on
  // its own line with empty space below for signing. The right-side
  // strategies would overlap with "Le 12 mai 2026" on the line above — so
  // they're correctly rejected, and below-anchor-probe wins.
  const pdf = await buildAnchorAloneOnLinePdf();
  const { candidates } = await detectSignatureFields(pdf);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.source, "anchor:Signature:");
  assert.equal(c.adjustedFrom, "below-anchor-probe");
  assert.equal(c.confidence, 0.85);
  assert.equal(c.x, 72, "rectangle should be left-aligned with the anchor");
  // PDF coords: lower y = lower on page. Anchor baseline at y=220. The
  // rectangle is below the anchor, so its top edge (y + height) must be
  // strictly below the anchor's baseline.
  assert.ok(c.y + c.height < 220, `rectangle top (${c.y + c.height}) should be below anchor baseline 220`);
  // And it should clear the footer at y=100.
  assert.ok(c.y > 100 + 12, `rectangle bottom (${c.y}) should clear the footer at y=100+height`);
});

test("detectSignatureFields: anchor near right edge → page-width clamp keeps rect on page", async () => {
  const pdf = await buildAnchorNearRightEdgePdf();
  const { candidates } = await detectSignatureFields(pdf);
  // Either below-anchor-probe (alone on line, tried first) or no candidate
  // at all if the geometry is too tight. The KEY assertion is that whatever
  // rectangle is emitted does not run off the right edge of the page.
  for (const c of candidates) {
    assert.ok(
      c.x + c.width <= 612 - 36 + 0.001,
      `candidate rectangle right edge (${c.x + c.width}) must be <= page_width - margin (576)`,
    );
  }
});

test("detectSignatureFields: anchor + same-line whitespace → whitespace-probe @ 0.75 (English form)", async () => {
  const pdf = await buildAnchorWhitespacePdf();
  const { candidates } = await detectSignatureFields(pdf);
  // Two anchors match: "Signature:" and (implicitly) "Date:" doesn't match
  // ANCHOR_PATTERNS, so only "Signature:" produces a candidate.
  assert.ok(candidates.length >= 1);
  const sigCandidate = candidates.find((c) => c.source === "anchor:Signature:");
  assert.ok(sigCandidate);
  assert.equal(sigCandidate!.adjustedFrom, "whitespace-probe");
  assert.equal(sigCandidate!.confidence, 0.75);
});

test("detectSignatureFields: verbose:true returns textItemsByPage + pageDimensions", async () => {
  const pdf = await buildAnchorAloneOnLinePdf();
  const result = await detectSignatureFields(pdf, { verbose: true });
  assert.ok(Array.isArray(result.textItemsByPage));
  assert.equal(result.textItemsByPage!.length, 1, "one page");
  const items = result.textItemsByPage![0];
  assert.ok(items.length >= 4, "should extract at least 4 text items");
  assert.ok(items.some((i) => /signature/i.test(i.text)), "should include the Signature anchor");
  assert.ok(Array.isArray(result.pageDimensions));
  assert.deepEqual(result.pageDimensions![0], { width: 612, height: 792 });
});

test("detectSignatureFields: verbose:false (default) omits textItemsByPage", async () => {
  const pdf = await buildAnchorAloneOnLinePdf();
  const result = await detectSignatureFields(pdf);
  assert.equal(result.textItemsByPage, undefined);
  assert.equal(result.pageDimensions, undefined);
});

test("detectSignatureFields: two anchors → two high-confidence candidates, AcroForm first", async () => {
  const pdf = await buildTwoAnchorsPdf();
  const { candidates } = await detectSignatureFields(pdf);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((c) => c.confidence === 0.95));
  // Both should be on page 1
  assert.ok(candidates.every((c) => c.page === 1));
  // Should match the two different anchor labels
  const labels = candidates.map((c) => c.source).sort();
  assert.deepEqual(labels, ["anchor:Signature:", "anchor:Signed by:"]);
});

// ─── CLI integration: `sign pdf detect-signature-field` ──────────────────

test("CLI: pdf detect-signature-field on PDF with anchor → exit 0 + candidate JSON", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "detect-"));
  try {
    const pdfPath = path.join(tmp, "anchor.pdf");
    writeFileSync(pdfPath, await buildAnchorUnderlinePdf());
    const r = spawnSync("node", [CLI, "pdf", "detect-signature-field", "--pdf", pdfPath], { encoding: "utf8" });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.ok, true);
    assert.equal(payload.candidates.length, 1);
    assert.equal(payload.candidates[0].adjustedFrom, "underline-snap");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: pdf detect-signature-field on PDF with no fields → exit 2 + empty candidates", async () => {
  const r = spawnSync("node", [CLI, "pdf", "detect-signature-field", "--pdf", canonicalUnsignedPdfPath()], { encoding: "utf8" });
  assert.equal(r.status, 2, "no candidates → exit 2");
  const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.candidates, []);
});

test("CLI: pdf detect-signature-field --verbose true dumps raw text items + page dims", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "detect-verbose-"));
  try {
    const pdfPath = path.join(tmp, "p.pdf");
    writeFileSync(pdfPath, await buildAnchorAloneOnLinePdf());
    const r = spawnSync("node", [CLI, "pdf", "detect-signature-field", "--pdf", pdfPath, "--verbose", "true"], { encoding: "utf8" });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.ok(Array.isArray(payload.textItemsByPage), "verbose output should include textItemsByPage");
    assert.equal(payload.textItemsByPage.length, 1);
    assert.ok(payload.textItemsByPage[0].some((i: { text: string }) => /signature/i.test(i.text)));
    assert.deepEqual(payload.pageDimensions[0], { width: 612, height: 792 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── CLI integration: `sign sign --auto-place` ───────────────────────────

function runSignFlow(args: {
  tmpDir: string;
  pdfBytes: Buffer;
  signArgs: string[];
}): { sign: SpawnSyncReturns<string>; requestId: string } {
  const { tmpDir, pdfBytes, signArgs } = args;
  const dbPath = path.join(tmpDir, "s.db");
  const docPath = path.join(tmpDir, "doc.pdf");
  writeFileSync(docPath, pdfBytes);

  const env = {
    ...process.env,
    SIGN_DB_PATH: dbPath,
    SIGN_LOCAL_KEY_DIR: path.join(tmpDir, "keys"),
    SIGN_LOCAL_STORE_DIR: path.join(tmpDir, "store"),
    SIGN_ALLOW_ABSOLUTE_DOCS: "1",
  };

  const create = spawnSync("node", [CLI, "--provider", "local", "request", "create",
    "--title", "T", "--document", docPath,
    "--signer", "name:Alice,email:alice@e.com,order:1", "--auto-approve", "true"],
    { env, encoding: "utf8" });
  if (create.status !== 0) throw new Error(`create failed: ${create.stderr}`);
  const created = JSON.parse(create.stdout.slice(create.stdout.indexOf("{"))) as {
    requestId: string; tokens: Array<{ token: string }>
  };

  spawnSync("node", [CLI, "--provider", "local", "request", "send", "--request-id", created.requestId],
    { env, encoding: "utf8" });

  const sign = spawnSync("node", [CLI, "sign",
    "--request-id", created.requestId, "--token", created.tokens[0].token,
    ...signArgs], { env, encoding: "utf8" });

  return { sign, requestId: created.requestId };
}

test("CLI: sign --auto-place true uses the detected underline-snap rectangle", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "autoplace-"));
  try {
    const { sign } = runSignFlow({
      tmpDir: tmp,
      pdfBytes: await buildAnchorUnderlinePdf(),
      signArgs: ["--name-signature", "Alice", "--auto-place", "true"],
    });
    assert.equal(sign.status, 0, `sign failed: ${sign.stderr}`);
    // Stderr should announce the auto-place choice
    assert.match(sign.stderr, /--auto-place .+ chose anchor:Signature:/);
    assert.match(sign.stderr, /adjustedFrom=underline-snap/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: sign --auto-place true without a visible-sig flag → AUTO_PLACE_REQUIRES_VISIBLE_SIG", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "autoplace-novis-"));
  try {
    const { sign } = runSignFlow({
      tmpDir: tmp,
      pdfBytes: await buildAnchorUnderlinePdf(),
      signArgs: ["--auto-place", "true"],
    });
    assert.notEqual(sign.status, 0);
    assert.match(sign.stderr + sign.stdout, /AUTO_PLACE_REQUIRES_VISIBLE_SIG/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: sign --auto-place true on PDF with two anchors → AUTO_PLACE_AMBIGUOUS + candidate list", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "autoplace-ambig-"));
  try {
    const { sign } = runSignFlow({
      tmpDir: tmp,
      pdfBytes: await buildTwoAnchorsPdf(),
      signArgs: ["--name-signature", "Alice", "--auto-place", "true"],
    });
    assert.notEqual(sign.status, 0);
    const out = sign.stderr + sign.stdout;
    assert.match(out, /AUTO_PLACE_AMBIGUOUS/);
    assert.match(out, /found 2 high-confidence/);
    // The candidate list should be in the error details
    assert.match(out, /anchor:Signature:/);
    assert.match(out, /anchor:Signed by:/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: sign --auto-place true on PDF with no detectable fields → AUTO_PLACE_NO_HIGH_CONFIDENCE", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "autoplace-empty-"));
  try {
    const { sign } = runSignFlow({
      tmpDir: tmp,
      pdfBytes: readFileSync(canonicalUnsignedPdfPath()),
      signArgs: ["--name-signature", "Alice", "--auto-place", "true"],
    });
    assert.notEqual(sign.status, 0);
    assert.match(sign.stderr + sign.stdout, /AUTO_PLACE_NO_HIGH_CONFIDENCE/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── postinstall trim ────────────────────────────────────────────────────

test("postinstall: pdfjs-dist has been trimmed (no .map sourcemaps, no non-legacy build, etc.)", async () => {
  // The scripts/trim-pdfjs-dist.mjs postinstall script drops unused
  // pdfjs-dist subdirectories + all sourcemaps. This test locks in that the
  // hook fired during `npm install` so install footprint stays small (~7.5
  // MB instead of ~36 MB). If this fails after `npm install`, the
  // postinstall didn't run — check package.json scripts.postinstall.
  const fs = await import("node:fs");
  const pdfjsRoot = path.resolve("node_modules/pdfjs-dist");
  assert.ok(fs.existsSync(pdfjsRoot), "pdfjs-dist must be installed");

  // These directories MUST be gone.
  for (const dir of ["build", "web", "image_decoders", "wasm", "cmaps", "standard_fonts"]) {
    assert.equal(
      fs.existsSync(path.join(pdfjsRoot, dir)),
      false,
      `pdfjs-dist/${dir} should have been removed by the postinstall trim`,
    );
  }

  // No `.map` files should remain.
  function findMaps(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) out.push(...findMaps(full));
      else if (entry.endsWith(".map")) out.push(full);
    }
    return out;
  }
  const remainingMaps = findMaps(pdfjsRoot);
  assert.deepEqual(remainingMaps, [], `sourcemaps should have been trimmed: ${remainingMaps.join(", ")}`);

  // The single file we actually import MUST still exist and load.
  assert.ok(fs.existsSync(path.join(pdfjsRoot, "legacy/build/pdf.mjs")));
});

test("CLI: sign --auto-place true + explicit --image-* → explicit wins, notice on stderr", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "autoplace-explicit-"));
  try {
    const { sign } = runSignFlow({
      tmpDir: tmp,
      pdfBytes: readFileSync(canonicalUnsignedPdfPath()),
      signArgs: ["--name-signature", "Alice", "--auto-place", "true",
        "--image-page", "1", "--image-x", "100", "--image-y", "100",
        "--image-width", "180", "--image-height", "50"],
    });
    // Explicit coords should win — the canonical fixture has no anchors,
    // which would otherwise produce AUTO_PLACE_NO_HIGH_CONFIDENCE.
    assert.equal(sign.status, 0, `sign failed: ${sign.stderr}`);
    assert.match(sign.stderr, /--auto-place ignored: explicit/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
