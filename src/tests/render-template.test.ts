import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

// Dynamic-import the .mjs script so we don't need a separate TS build for it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "..", "..", "scripts", "render-template.mjs");
const { parseBlocks, substitute, wrapWords, renderToPdf } = await import(scriptPath);

test("substitute replaces every {{KEY}} occurrence and errors on unresolved", () => {
  const out = substitute("Hello {{NAME}}, today is {{DATE}}.", { NAME: "Carol", DATE: "Jan 15" });
  assert.equal(out, "Hello Carol, today is Jan 15.");

  assert.throws(
    () => substitute("Hello {{NAME}}, {{MISSING}} too.", { NAME: "Carol" }),
    /unresolved placeholders: MISSING/,
  );
});

test("parseBlocks splits a small NDA-shaped document into title / heading / paragraph blocks", () => {
  const md = `# Title here

First paragraph,
spanning two lines.

## Section 2

Second paragraph.`;
  const blocks = parseBlocks(md);
  assert.deepEqual(blocks, [
    { type: "title", text: "Title here" },
    { type: "para", text: "First paragraph, spanning two lines." },
    { type: "heading", text: "Section 2" },
    { type: "para", text: "Second paragraph." },
  ]);
});

test("wrapWords keeps lines under the measured max width", async () => {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont("Helvetica" as any);
  const text = "the quick brown fox jumps over the lazy dog ".repeat(8).trim();
  const lines = wrapWords(text, helv, 11, 200); // narrow column to force several wraps
  assert.ok(lines.length >= 4, `expected at least 4 wrapped lines, got ${lines.length}`);
  for (const line of lines) {
    const width = helv.widthOfTextAtSize(line, 11);
    assert.ok(width <= 200 + 1e-6, `line "${line}" is ${width}pt wide, exceeds 200`);
  }
});

test("renderToPdf produces a valid multi-page PDF when content overflows one page", async () => {
  // Build a synthetic block list large enough to force a second page.
  const blocks = [{ type: "title", text: "Long doc" }];
  for (let i = 0; i < 30; i++) {
    blocks.push({ type: "para", text: `Paragraph ${i}. ${"word ".repeat(60).trim()}` });
  }
  const bytes = await renderToPdf(blocks as any);
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 2, `expected ≥2 pages, got ${pdf.getPageCount()}`);
});

test("end-to-end: rendering the bundled NDA template with example vars produces a real PDF", async () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const template = readFileSync(path.join(repoRoot, "fixtures", "templates", "mutual-nda.md"), "utf8");
  const vars = JSON.parse(readFileSync(path.join(repoRoot, "fixtures", "templates", "mutual-nda.example.json"), "utf8"));
  const substituted = substitute(template, vars);
  const blocks = parseBlocks(substituted);
  const bytes = await renderToPdf(blocks);

  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 1);

  // The substituted text should no longer contain any {{...}} placeholders.
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(substituted), "no placeholders left after substitution");

  // The method-consent clause must be present in the rendered source —
  // that's the whole point of the template per docs/legal-posture.md.
  assert.match(substituted, /electronic signature/i);
  assert.match(substituted, /method of execution/i);

  // Spot-check that the example party names made it in.
  assert.ok(substituted.includes("Alpha Inc."));
  assert.ok(substituted.includes("Beta GmbH"));
});
