import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { encodePng } from "../lib/png-bounds.js";

const CLI = path.resolve("dist/cli.js");

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

function smallSignaturePng(): Buffer {
  const pixels = new Uint8Array(100 * 40 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0; pixels[i + 1] = 120; pixels[i + 2] = 80; pixels[i + 3] = 255;
  }
  return encodePng({ width: 100, height: 40, channels: 4, pixels });
}

function runPreview(args: string[]): SpawnSyncReturns<string> {
  // Tests write to /tmp/... paths; allow absolute output paths in this
  // test harness via SIGN_ALLOW_ABSOLUTE_DOCS=1 (same convention as the
  // other CLI integration tests). Production users get the
  // path-traversal guard.
  return spawnSync("node", [CLI, "preview", ...args], {
    encoding: "utf8",
    env: { ...process.env, SIGN_ALLOW_ABSOLUTE_DOCS: "1" },
  });
}

test("CLI preview: rejects --out paths that escape CWD without SIGN_ALLOW_ABSOLUTE_DOCS", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preview-traversal-"));
  try {
    const pdfPath = path.join(tmp, "doc.pdf");
    const sigPath = path.join(tmp, "sig.png");
    writeFileSync(pdfPath, await buildTwoAnchorsPdf());
    writeFileSync(sigPath, smallSignaturePng());
    // Deliberately do NOT pass SIGN_ALLOW_ABSOLUTE_DOCS — production default.
    const r = spawnSync("node", [CLI, "preview",
      "--pdf", pdfPath, "--signature-image", sigPath,
      "--auto-place", "first", "--out", "/tmp/escaped-cwd.pdf",
    ], { encoding: "utf8", env: { ...process.env, SIGN_ALLOW_ABSOLUTE_DOCS: "" } });
    assert.notEqual(r.status, 0, "preview should reject absolute --out paths without the opt-in flag");
    assert.match(r.stderr + r.stdout, /escapes the working directory|SIGN_ALLOW_ABSOLUTE_DOCS/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI preview: emits drawnRects that round-trip through pdf stamp verify", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preview-drawn-"));
  try {
    const pdfPath = path.join(tmp, "doc.pdf");
    const sigPath = path.join(tmp, "sig.png");
    const outPath = path.join(tmp, "preview.pdf");
    writeFileSync(pdfPath, await buildTwoAnchorsPdf());
    writeFileSync(sigPath, smallSignaturePng());

    const r = runPreview([
      "--pdf", pdfPath, "--signature-image", sigPath,
      "--auto-place", "first", "--out", outPath,
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.ok(Array.isArray(payload.drawnRects), "preview must emit drawnRects array");
    assert.equal(payload.drawnRects.length, 1, "one drawn rect for the chosen anchor");

    // Round-trip: pdf stamp verify against drawnRects[0] → verdict=ok
    const d = payload.drawnRects[0];
    const verify = spawnSync("node", [CLI, "pdf", "stamp", "verify", "--pdf", outPath,
      "--image-page", String(d.page),
      "--image-x", String(d.x),
      "--image-y", String(d.y),
      "--image-width", String(d.width),
      "--image-height", String(d.height),
    ], { encoding: "utf8", env: { ...process.env, SIGN_ALLOW_ABSOLUTE_DOCS: "1" } });
    const verifyJson = JSON.parse(verify.stdout.slice(verify.stdout.indexOf("{")));
    assert.equal(verifyJson.verdict, "ok",
      "drawnRects[0] from sign preview should round-trip through pdf stamp verify");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI preview: --auto-place all stamps at every high-confidence candidate", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preview-all-"));
  try {
    const pdfPath = path.join(tmp, "doc.pdf");
    const sigPath = path.join(tmp, "sig.png");
    const outPath = path.join(tmp, "preview.pdf");
    writeFileSync(pdfPath, await buildTwoAnchorsPdf());
    writeFileSync(sigPath, smallSignaturePng());

    const r = runPreview([
      "--pdf", pdfPath, "--signature-image", sigPath,
      "--auto-place", "all", "--out", outPath,
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.sealed, false);
    assert.equal(payload.positions.length, 2);
    // Both rectangles should be inside the page
    for (const p of payload.positions) {
      assert.equal(p.page, 1);
      assert.ok(p.x > 0 && p.y > 0);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI preview: --auto-place first picks the top-of-page candidate", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preview-first-"));
  try {
    const pdfPath = path.join(tmp, "doc.pdf");
    const sigPath = path.join(tmp, "sig.png");
    const outPath = path.join(tmp, "preview.pdf");
    writeFileSync(pdfPath, await buildTwoAnchorsPdf());
    writeFileSync(sigPath, smallSignaturePng());

    const r = runPreview([
      "--pdf", pdfPath, "--signature-image", sigPath,
      "--auto-place", "first", "--out", outPath,
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.positions.length, 1);
    // The "first" candidate on page 1 has y closer to 596 (top), not 296.
    assert.ok(payload.positions[0].y > 500, `expected top-of-page y; got ${payload.positions[0].y}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI preview: --auto-place index:1 picks the second candidate", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preview-idx-"));
  try {
    const pdfPath = path.join(tmp, "doc.pdf");
    const sigPath = path.join(tmp, "sig.png");
    const outPath = path.join(tmp, "preview.pdf");
    writeFileSync(pdfPath, await buildTwoAnchorsPdf());
    writeFileSync(sigPath, smallSignaturePng());

    const r = runPreview([
      "--pdf", pdfPath, "--signature-image", sigPath,
      "--auto-place", "index:1", "--out", outPath,
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.positions.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI preview: --auto-place bogus → INVALID_AUTO_PLACE_VALUE", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preview-bad-"));
  try {
    const pdfPath = path.join(tmp, "doc.pdf");
    const sigPath = path.join(tmp, "sig.png");
    writeFileSync(pdfPath, await buildTwoAnchorsPdf());
    writeFileSync(sigPath, smallSignaturePng());

    const r = runPreview([
      "--pdf", pdfPath, "--signature-image", sigPath,
      "--auto-place", "bogus", "--out", path.join(tmp, "out.pdf"),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /INVALID_AUTO_PLACE_VALUE/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI preview: --auto-place index:99 → AUTO_PLACE_INDEX_OUT_OF_RANGE with candidate list", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preview-oor-"));
  try {
    const pdfPath = path.join(tmp, "doc.pdf");
    const sigPath = path.join(tmp, "sig.png");
    writeFileSync(pdfPath, await buildTwoAnchorsPdf());
    writeFileSync(sigPath, smallSignaturePng());

    const r = runPreview([
      "--pdf", pdfPath, "--signature-image", sigPath,
      "--auto-place", "index:99", "--out", path.join(tmp, "out.pdf"),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /AUTO_PLACE_INDEX_OUT_OF_RANGE/);
    assert.match(r.stderr + r.stdout, /candidates/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI preview: output declares sealed:false (it's a draft, not a PAdES envelope)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preview-sealed-"));
  try {
    const pdfPath = path.join(tmp, "doc.pdf");
    const sigPath = path.join(tmp, "sig.png");
    const outPath = path.join(tmp, "preview.pdf");
    writeFileSync(pdfPath, await buildTwoAnchorsPdf());
    writeFileSync(sigPath, smallSignaturePng());

    const r = runPreview([
      "--pdf", pdfPath, "--signature-image", sigPath,
      "--auto-place", "first", "--out", outPath,
    ]);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.sealed, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI preview: without --signature-image or --name-signature → MISSING_FLAG", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "preview-novis-"));
  try {
    const pdfPath = path.join(tmp, "doc.pdf");
    writeFileSync(pdfPath, await buildTwoAnchorsPdf());

    const r = runPreview([
      "--pdf", pdfPath, "--auto-place", "first",
      "--out", path.join(tmp, "out.pdf"),
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /MISSING_FLAG|--signature-image or --name-signature/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
