#!/usr/bin/env node
// Renders a minimal markdown template (title, headings, paragraphs) to PDF
// with {{PLACEHOLDER}} substitution. Designed for sign-cli's NDA template
// and similar short contracts — NOT a general-purpose markdown renderer.
//
// Supported markdown:
//   `# Title`         → Helvetica-Bold 20pt
//   `## Heading`      → Helvetica-Bold 13pt with a small gap above
//   Blank line        → paragraph separator
//   {{KEY}}           → substituted from --var KEY=VALUE or --vars file.json
//
// Not supported (by design — would make this script much bigger):
//   inline formatting (*italic*, **bold**), lists, tables, links, images,
//   code blocks. Use docx2pdf-cli or pandoc for richer markdown.
//
// Usage:
//   node scripts/render-template.mjs \
//     --template fixtures/templates/mutual-nda.md \
//     --out alpha-beta-nda.pdf \
//     --vars fixtures/templates/mutual-nda.example.json
//
//   node scripts/render-template.mjs \
//     --template fixtures/templates/mutual-nda.md \
//     --out alpha-beta-nda.pdf \
//     --var EFFECTIVE_DATE="15 January 2026" \
//     --var PARTY_A_NAME="Alpha Inc." [...]

import { readFileSync, writeFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";

function parseArgs(argv) {
  const args = { vars: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--template" || a === "--out") { args[a.slice(2)] = argv[++i]; }
    else if (a === "--vars") {
      const fileVars = JSON.parse(readFileSync(argv[++i], "utf8"));
      Object.assign(args.vars, fileVars);
    }
    else if (a === "--var") {
      const [k, ...rest] = argv[++i].split("=");
      if (!k || rest.length === 0) {
        throw new Error(`--var expects KEY=VALUE, got: ${argv[i]}`);
      }
      args.vars[k] = rest.join("=");
    }
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(new URL(import.meta.url)).toString()
        .split("\n").filter((l) => l.startsWith("//")).slice(0, 25).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exit(0);
    }
  }
  if (!args.template || !args.out) {
    throw new Error("Both --template and --out are required. Pass --help for usage.");
  }
  return args;
}

function substitute(template, vars) {
  const unresolved = new Set();
  const result = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => {
    if (vars[key] === undefined || vars[key] === null) {
      unresolved.add(key);
      return m;
    }
    return String(vars[key]);
  });
  if (unresolved.size > 0) {
    throw new Error(
      `Template has unresolved placeholders: ${[...unresolved].sort().join(", ")}.\n` +
      `Pass each via --var KEY=VALUE or list them all in a --vars FILE.json.`,
    );
  }
  return result;
}

// Parse the (substituted) markdown into a flat block list. Each block is
// either a title, heading, or paragraph; we don't recurse or handle inline
// formatting (deliberately — keeps the renderer tiny and predictable).
function parseBlocks(md) {
  const blocks = [];
  let para = "";
  function flushPara() {
    if (para.trim()) blocks.push({ type: "para", text: para.trim() });
    para = "";
  }
  for (const line of md.split("\n")) {
    if (line.startsWith("# ")) {
      flushPara();
      blocks.push({ type: "title", text: line.slice(2).trim() });
    } else if (line.startsWith("## ")) {
      flushPara();
      blocks.push({ type: "heading", text: line.slice(3).trim() });
    } else if (line.trim() === "") {
      flushPara();
    } else {
      para += (para ? " " : "") + line.trim();
    }
  }
  flushPara();
  return blocks;
}

// Greedy word-wrap against a measured font. Each word that overflows the
// remaining line width starts a new line.
function wrapWords(text, font, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

async function renderToPdf(blocks) {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612;   // US Letter
  const pageHeight = 792;
  const margin = 72;       // 1 inch
  const contentTop = pageHeight - margin;
  const contentBottom = margin;
  const contentLeft = margin;
  const contentWidth = pageWidth - 2 * margin;

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = contentTop;

  function newPage() {
    page = pdf.addPage([pageWidth, pageHeight]);
    y = contentTop;
  }

  function drawLine(text, font, size, leading) {
    if (y - leading < contentBottom) newPage();
    page.drawText(text, { x: contentLeft, y: y - size, font, size });
    y -= leading;
  }

  for (const b of blocks) {
    if (b.type === "title") {
      // Extra gap above title, larger leading below.
      if (y < contentTop - 1) y -= 6;
      drawLine(b.text, helvBold, 20, 28);
      y -= 8;
    } else if (b.type === "heading") {
      y -= 6;
      drawLine(b.text, helvBold, 13, 18);
      y -= 2;
    } else {
      for (const line of wrapWords(b.text, helv, 11, contentWidth)) {
        drawLine(line, helv, 11, 14);
      }
      y -= 6;
    }
  }

  return Buffer.from(await pdf.save());
}

async function main() {
  const args = parseArgs(process.argv);
  const template = readFileSync(args.template, "utf8");
  const substituted = substitute(template, args.vars);
  const blocks = parseBlocks(substituted);
  const pdfBytes = await renderToPdf(blocks);
  writeFileSync(args.out, pdfBytes);
  console.log(JSON.stringify({
    ok: true,
    template: args.template,
    out: args.out,
    bytes: pdfBytes.length,
    blocks: blocks.length,
    placeholdersResolved: Object.keys(args.vars).length,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`render-template: ${err.message}`);
    process.exit(1);
  });
}

export { parseBlocks, substitute, wrapWords, renderToPdf };
