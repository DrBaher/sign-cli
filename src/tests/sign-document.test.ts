import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { encodePng } from "../lib/png-bounds.js";
import { isDocxLikePath } from "../lib/docx2pdf-convert.js";

const CLI = path.resolve("dist/cli.js");

async function buildAnchorPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Signature:", { x: 72, y: 200, font: helv, size: 12 });
  page.drawText("_____________________", { x: 140, y: 200, font: helv, size: 12 });
  return Buffer.from(await doc.save());
}

function signaturePng(): Buffer {
  const pixels = new Uint8Array(80 * 30 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0; pixels[i + 1] = 80; pixels[i + 2] = 160; pixels[i + 3] = 255;
  }
  return encodePng({ width: 80, height: 30, channels: 4, pixels });
}

function runDocument(args: string[], extraEnv: NodeJS.ProcessEnv = {}): SpawnSyncReturns<string> {
  // Force SIGN_DB_PATH to a temp file so `sign document` doesn't even open
  // a main DB in the user's CWD as a side-effect of cli.ts's bootstrap.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-doc-env-"));
  try {
    return spawnSync("node", [CLI, "document", ...args], {
      encoding: "utf8",
      env: { ...process.env, SIGN_DB_PATH: path.join(tmp, "main.db"), SIGN_ALLOW_ABSOLUTE_DOCS: "1", ...extraEnv },
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── isDocxLikePath ──────────────────────────────────────────────────────

test("isDocxLikePath: recognizes word-processing extensions", () => {
  assert.equal(isDocxLikePath("/x/foo.docx"), true);
  assert.equal(isDocxLikePath("/x/foo.doc"), true);
  assert.equal(isDocxLikePath("/x/foo.odt"), true);
  assert.equal(isDocxLikePath("/x/foo.rtf"), true);
  assert.equal(isDocxLikePath("/x/foo.DOCX"), true, "case-insensitive");
  assert.equal(isDocxLikePath("/x/foo.pdf"), false);
  assert.equal(isDocxLikePath("/x/foo.png"), false);
  assert.equal(isDocxLikePath("/x/foo"), false);
});

// ─── End-to-end: PDF → signed PDF ────────────────────────────────────────

test("CLI: sign document on a PDF input → signed PDF, no DOCX conversion", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-doc-pdf-"));
  try {
    const inputPath = path.join(tmp, "in.pdf");
    const sigPath = path.join(tmp, "sig.png");
    const outPath = path.join(tmp, "signed.pdf");
    writeFileSync(inputPath, await buildAnchorPdf());
    writeFileSync(sigPath, signaturePng());

    const r = runDocument([
      inputPath,
      "--signer", "Baher Al Hakim",
      "--signature-image", sigPath,
      "--auto-place", "first",
      "--out", outPath,
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.ok, true);
    assert.equal(payload.converted, false, "PDF input skips DOCX conversion");
    assert.equal(payload.input, inputPath);
    assert.equal(payload.output, outPath);
    assert.equal(payload.placements.length, 1);
    assert.equal(payload.verify.chainValid, true);
    assert.ok(payload.verify.events > 0);
    assert.ok(payload.bytes > 1000, "output PDF should be > 1KB");
    // File actually exists on disk
    assert.ok(existsSync(outPath));
    const bytes = readFileSync(outPath);
    assert.ok(bytes.subarray(0, 5).toString("ascii") === "%PDF-", "output is a valid PDF header");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── --auto-place defaults to "first" when no explicit position ──────────

test("CLI: sign document without --auto-place defaults to first (picks the top anchor)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-doc-default-"));
  try {
    const inputPath = path.join(tmp, "in.pdf");
    const sigPath = path.join(tmp, "sig.png");
    const outPath = path.join(tmp, "signed.pdf");
    writeFileSync(inputPath, await buildAnchorPdf());
    writeFileSync(sigPath, signaturePng());

    const r = runDocument([
      inputPath,
      "--signer", "Alice",
      "--signature-image", sigPath,
      "--out", outPath,
      // No --auto-place specified
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.placements.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Error: missing --signer ─────────────────────────────────────────────

test("CLI: sign document without --signer → MISSING_FLAG", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-doc-nosigner-"));
  try {
    const inputPath = path.join(tmp, "in.pdf");
    writeFileSync(inputPath, await buildAnchorPdf());
    const r = runDocument([
      inputPath,
      "--signature-image", "doesnt-matter.png",
      "--out", path.join(tmp, "out.pdf"),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /MISSING_FLAG|--signer/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Error: missing --signature-image and --name-signature ──────────────

test("CLI: sign document with no visible-sig flag → MISSING_FLAG", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-doc-nosig-"));
  try {
    const inputPath = path.join(tmp, "in.pdf");
    writeFileSync(inputPath, await buildAnchorPdf());
    const r = runDocument([
      inputPath,
      "--signer", "Alice",
      "--out", path.join(tmp, "out.pdf"),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /MISSING_FLAG|--signature-image|--name-signature/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Error: no signature anchor in PDF ───────────────────────────────────

test("CLI: sign document with --auto-place but no anchors → AUTO_PLACE_NO_HIGH_CONFIDENCE", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-doc-noanchor-"));
  try {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const inputPath = path.join(tmp, "in.pdf");
    const sigPath = path.join(tmp, "sig.png");
    writeFileSync(inputPath, Buffer.from(await doc.save()));
    writeFileSync(sigPath, signaturePng());

    const r = runDocument([
      inputPath,
      "--signer", "Alice",
      "--signature-image", sigPath,
      "--auto-place", "first",
      "--out", path.join(tmp, "out.pdf"),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /AUTO_PLACE_NO_HIGH_CONFIDENCE/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Regression: drawnRects round-trips through pdf stamp verify ────────

test("CLI: sign document drawnRects round-trips through pdf stamp verify", async () => {
  // Catches the regression where `placements` (candidate rect) was the only
  // rect reported, but the actually-drawn rect is smaller when
  // --preserve-aspect-ratio is true (the default). Verifying `placements`
  // against the stamp would error wrong_position; verifying `drawnRects`
  // succeeds.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-doc-drawn-"));
  try {
    const inputPath = path.join(tmp, "in.pdf");
    const sigPath = path.join(tmp, "sig.png");
    const outPath = path.join(tmp, "signed.pdf");
    writeFileSync(inputPath, await buildAnchorPdf());
    // Build a sig with an aspect that doesn't match the box (forces shrink-
    // to-fit). Anchor underline is ~147pt wide; image is 200×80, aspect 2.5.
    const pixels = new Uint8Array(200 * 80 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 200; pixels[i + 3] = 255;
    }
    writeFileSync(sigPath, encodePng({ width: 200, height: 80, channels: 4, pixels }));

    const r = runDocument([
      inputPath,
      "--signer", "Alice",
      "--signature-image", sigPath,
      "--auto-place", "first",
      "--out", outPath,
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));

    assert.equal(payload.placements.length, 1);
    assert.equal(payload.drawnRects.length, 1);
    assert.ok(
      payload.drawnRects[0].width < payload.placements[0].width,
      `expected drawnRect.width (${payload.drawnRects[0].width}) < placement.width (${payload.placements[0].width}) when preserveAspectRatio=true`,
    );

    // Round-trip: pdf stamp verify against drawnRects[0] → verdict=ok
    const d = payload.drawnRects[0];
    const verify = spawnSync("node", [CLI, "pdf", "stamp", "verify", "--pdf", outPath,
      "--image-page", String(d.page),
      "--image-x", String(d.x),
      "--image-y", String(d.y),
      "--image-width", String(d.width),
      "--image-height", String(d.height),
    ], { encoding: "utf8" });
    const verifyJson = JSON.parse(verify.stdout.slice(verify.stdout.indexOf("{")));
    assert.equal(verifyJson.verdict, "ok",
      `drawnRects should round-trip through stamp verify; got ${verifyJson.verdict}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── DOCX → ensure we DON'T import docx2pdf-cli's logic ──────────────────

test("docx2pdf-convert: re-exports a thin convert function; no own conversion logic", async () => {
  // Smoke check that the module exposes only what we need and nothing more.
  const mod = await import("../lib/docx2pdf-convert.js");
  assert.ok(typeof mod.convertDocxToPdf === "function");
  assert.ok(typeof mod.isDocxLikePath === "function");
  // No backend-related types/functions re-exported — docx2pdf-cli stays the
  // source of truth for converter behavior.
  assert.equal((mod as Record<string, unknown>).runConversion, undefined);
  assert.equal((mod as Record<string, unknown>).DocxBackend, undefined);
});
