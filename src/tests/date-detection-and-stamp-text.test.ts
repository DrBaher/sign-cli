import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { detectSignatureFields } from "../lib/signature-field-detection.js";

const CLI = path.resolve("dist/cli.js");

async function buildSigDatePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Signature:", { x: 72, y: 500, font: helv, size: 12 });
  page.drawText("______________________", { x: 140, y: 500, font: helv, size: 12 });
  page.drawText("Date:", { x: 72, y: 400, font: helv, size: 12 });
  page.drawText("______________________", { x: 110, y: 400, font: helv, size: 12 });
  page.drawText("Date d'effet:", { x: 72, y: 300, font: helv, size: 12 });
  page.drawText("12 mai 2026", { x: 145, y: 300, font: helv, size: 12 });
  return Buffer.from(await doc.save());
}

async function buildDateOnlyPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Date:", { x: 72, y: 400, font: helv, size: 12 });
  page.drawText("______________________", { x: 110, y: 400, font: helv, size: 12 });
  return Buffer.from(await doc.save());
}

// ─── Detection: category split + alreadyFilled ──────────────────────────

test("detectSignatureFields: categorizes signature vs date anchors", async () => {
  const pdf = await buildSigDatePdf();
  const r = await detectSignatureFields(pdf);
  assert.equal(r.signatureCandidates.length, 1, "one Signature: anchor");
  assert.equal(r.signatureCandidates[0].category, "signature");
  assert.equal(r.dateCandidates.length, 2, "Date: + Date d'effet:");
  assert.ok(r.dateCandidates.every((c) => c.category === "date"));
});

test("detectSignatureFields: alreadyFilled set when date text is nearby", async () => {
  const pdf = await buildSigDatePdf();
  const r = await detectSignatureFields(pdf);
  const blankDate = r.dateCandidates.find((c) => c.source === "anchor:Date:");
  const filledDate = r.dateCandidates.find((c) => c.source === "anchor:Date d'effet:");
  assert.ok(blankDate);
  assert.ok(filledDate);
  assert.equal(blankDate!.alreadyFilled, false, "blank Date: should not be flagged");
  assert.equal(filledDate!.alreadyFilled, true, "Date d'effet followed by '12 mai 2026' should be flagged");
});

test("detectSignatureFields: alreadyFilled does NOT cross-pollute between adjacent anchors", async () => {
  // Regression: a blank `Date:` immediately above a `Date d'effet: 12 mai 2026`
  // line would incorrectly inherit alreadyFilled=true because the
  // line-below probe found the OTHER anchor's date. The fix is to limit
  // alreadyFilled detection to same-line-right only.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Date:", { x: 72, y: 460, font: helv, size: 12 });
  page.drawText("______________________", { x: 110, y: 460, font: helv, size: 12 });
  page.drawText("Date d'effet:", { x: 72, y: 420, font: helv, size: 12 });
  page.drawText("12 mai 2026", { x: 145, y: 420, font: helv, size: 12 });
  const r = await detectSignatureFields(Buffer.from(await doc.save()));
  const blankDate = r.dateCandidates.find((c) => c.source === "anchor:Date:");
  const filledDate = r.dateCandidates.find((c) => c.source === "anchor:Date d'effet:");
  assert.ok(blankDate);
  assert.ok(filledDate);
  assert.equal(blankDate!.alreadyFilled, false,
    "blank Date: must NOT inherit alreadyFilled from the adjacent Date d'effet: anchor");
  assert.equal(filledDate!.alreadyFilled, true);
});

test("detectSignatureFields: candidates list is unified (signature + date together)", async () => {
  const pdf = await buildSigDatePdf();
  const r = await detectSignatureFields(pdf);
  assert.equal(r.candidates.length, r.signatureCandidates.length + r.dateCandidates.length);
});

// ─── CLI: detect-signature-field is signature-only (backward compat) ──────

test("CLI: pdf detect-signature-field returns only signature candidates (no date anchors)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "detect-sig-"));
  try {
    const pdfPath = path.join(tmp, "p.pdf");
    writeFileSync(pdfPath, await buildSigDatePdf());
    const r = spawnSync("node", [CLI, "pdf", "detect-signature-field", "--pdf", pdfPath], { encoding: "utf8" });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.candidates.length, 1);
    assert.equal(payload.candidates[0].source, "anchor:Signature:");
    // Make sure no date anchor leaked
    assert.ok(payload.candidates.every((c: { category: string }) => c.category === "signature"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── CLI: detect-date-field is date-only ─────────────────────────────────

test("CLI: pdf detect-date-field returns date candidates with alreadyFilled flag", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "detect-date-"));
  try {
    const pdfPath = path.join(tmp, "p.pdf");
    writeFileSync(pdfPath, await buildSigDatePdf());
    const r = spawnSync("node", [CLI, "pdf", "detect-date-field", "--pdf", pdfPath], { encoding: "utf8" });
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.candidates.length, 2);
    assert.ok(payload.candidates.every((c: { category: string }) => c.category === "date"));
    const sources = payload.candidates.map((c: { source: string }) => c.source).sort();
    assert.deepEqual(sources, ["anchor:Date d'effet:", "anchor:Date:"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: pdf detect-date-field exits 2 when no date anchors found", async () => {
  // PDF with only signature anchors → no date candidates
  const tmp = mkdtempSync(path.join(os.tmpdir(), "detect-date-empty-"));
  try {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Signature:", { x: 72, y: 500, font: helv, size: 12 });
    page.drawText("______________________", { x: 140, y: 500, font: helv, size: 12 });
    const pdfPath = path.join(tmp, "p.pdf");
    writeFileSync(pdfPath, Buffer.from(await doc.save()));
    const r = spawnSync("node", [CLI, "pdf", "detect-date-field", "--pdf", pdfPath], { encoding: "utf8" });
    assert.equal(r.status, 2, "no date candidates → exit 2");
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.deepEqual(payload.candidates, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── CLI: stamp-text ─────────────────────────────────────────────────────

function runStampText(args: string[]): SpawnSyncReturns<string> {
  return spawnSync("node", [CLI, "pdf", "stamp-text", ...args], { encoding: "utf8" });
}

test("CLI: pdf stamp-text --auto-place all skips alreadyFilled by default", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "stamp-text-"));
  try {
    const pdfPath = path.join(tmp, "p.pdf");
    const outPath = path.join(tmp, "out.pdf");
    writeFileSync(pdfPath, await buildSigDatePdf());
    const r = runStampText([
      "--pdf", pdfPath, "--text", "12 mai 2026",
      "--auto-place", "all", "--out", outPath,
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    // Only the blank Date: anchor was stamped — the alreadyFilled
    // Date d'effet: was skipped.
    assert.equal(payload.positions.length, 1);
    assert.equal(payload.text, "12 mai 2026");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: pdf stamp-text --overwrite-filled true stamps at every date candidate", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "stamp-text-ow-"));
  try {
    const pdfPath = path.join(tmp, "p.pdf");
    const outPath = path.join(tmp, "out.pdf");
    writeFileSync(pdfPath, await buildSigDatePdf());
    const r = runStampText([
      "--pdf", pdfPath, "--text", "12 mai 2026",
      "--auto-place", "all", "--overwrite-filled", "true",
      "--out", outPath,
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.positions.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: pdf stamp-text with only filled candidates + default skip → AUTO_PLACE_NO_HIGH_CONFIDENCE + hint", async () => {
  // PDF where every date candidate is alreadyFilled. With the default skip,
  // the date pool is empty → selector returns NO_HIGH_CONFIDENCE.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "stamp-text-skip-"));
  try {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Date d'effet:", { x: 72, y: 300, font: helv, size: 12 });
    page.drawText("12 mai 2026", { x: 145, y: 300, font: helv, size: 12 });
    const pdfPath = path.join(tmp, "p.pdf");
    writeFileSync(pdfPath, Buffer.from(await doc.save()));
    const r = runStampText([
      "--pdf", pdfPath, "--text", "12 mai 2026",
      "--auto-place", "all", "--out", path.join(tmp, "out.pdf"),
    ]);
    assert.notEqual(r.status, 0);
    const out = r.stdout + r.stderr;
    assert.match(out, /AUTO_PLACE_NO_HIGH_CONFIDENCE/);
    assert.match(out, /already filled|--overwrite-filled/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI: pdf stamp-text with explicit --image-* coords (no --auto-place)", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "stamp-text-explicit-"));
  try {
    const pdfPath = path.join(tmp, "p.pdf");
    const outPath = path.join(tmp, "out.pdf");
    writeFileSync(pdfPath, await buildDateOnlyPdf());
    const r = runStampText([
      "--pdf", pdfPath, "--text", "2026-05-12",
      "--image-page", "1", "--image-x", "100", "--image-y", "200",
      "--image-width", "150", "--image-height", "30",
      "--out", outPath,
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    const payload = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    assert.equal(payload.positions.length, 1);
    assert.equal(payload.positions[0].x, 100);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── sign sign --auto-place is signature-category only ───────────────────

test("CLI: sign sign --auto-place ignores date anchors (signature category only)", async () => {
  // Build a request with the sig+date PDF and check that --auto-place all
  // doesn't try to stamp signatures at date anchors.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-cat-"));
  try {
    const docPath = path.join(tmp, "doc.pdf");
    writeFileSync(docPath, await buildSigDatePdf());
    const env = {
      ...process.env,
      SIGN_DB_PATH: path.join(tmp, "s.db"),
      SIGN_LOCAL_KEY_DIR: path.join(tmp, "keys"),
      SIGN_LOCAL_STORE_DIR: path.join(tmp, "store"),
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

    // The PDF has 1 signature anchor + 2 date anchors. --auto-place all
    // would error AUTO_PLACE_AMBIGUOUS without category filtering (3
    // high-confidence candidates) — but with the filter, only the unique
    // Signature: candidate qualifies, so it succeeds.
    const sign = spawnSync("node", [CLI, "sign",
      "--request-id", created.requestId, "--token", created.tokens[0].token,
      "--name-signature", "Alice", "--auto-place", "all"], { env, encoding: "utf8" });
    assert.equal(sign.status, 0, `sign failed: ${sign.stderr}`);
    assert.match(sign.stderr, /chose anchor:Signature:/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
