// Typed Markdown→PDF mini-renderer for short contract templates (NDA, MSA, etc.).
// Lifted into TypeScript from scripts/render-template.mjs so workflow commands
// (Item 7) can call it programmatically without shelling out to node.
//
// Supports:
//   # Title       → Helvetica-Bold 20pt
//   ## Heading    → Helvetica-Bold 13pt
//   blank line    → paragraph break
//   {{KEY}}       → substitution from a values map; missing keys throw.
//
// NOT supported (by design — would balloon scope):
//   inline *italic*/**bold**, lists, tables, links, images, code blocks.
//   Use pandoc/docx2pdf for richer documents.

import { PDFDocument, PDFFont, StandardFonts } from "pdf-lib";

export type RenderedBlock =
  | { type: "title"; text: string }
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string };

export type TemplateValues = Record<string, string>;

const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

/** Substitute every `{{KEY}}` in `template` with values[KEY]. Throws if any
 *  placeholder has no corresponding value — silent gaps in legal text are
 *  the worst possible failure mode for an NDA workflow. */
export function substitute(template: string, values: TemplateValues): string {
  const unresolved = new Set<string>();
  const out = template.replace(PLACEHOLDER_RE, (match, key: string) => {
    const v = values[key];
    if (v === undefined || v === null) {
      unresolved.add(key);
      return match;
    }
    return String(v);
  });
  if (unresolved.size > 0) {
    throw new Error(
      `Template has unresolved placeholders: ${[...unresolved].sort().join(", ")}. ` +
      `Provide every key via --value KEY=VALUE or list them all in --values FILE.json.`,
    );
  }
  return out;
}

/** Return every `{{KEY}}` referenced in the template — useful for `nda` to
 *  validate values BEFORE calling substitute (so we can surface a single
 *  consolidated error rather than fail-fast on the first missing key). */
export function placeholders(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    seen.add(m[1]);
  }
  return [...seen].sort();
}

/** Flatten the substituted markdown into a list of paragraph-level blocks.
 *  No inline parsing, no recursion. */
export function parseBlocks(md: string): RenderedBlock[] {
  const blocks: RenderedBlock[] = [];
  let para = "";
  const flushPara = () => {
    if (para.trim().length > 0) {
      blocks.push({ type: "paragraph", text: para.trim().replace(/\s+/g, " ") });
    }
    para = "";
  };
  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine;
    if (line.startsWith("# ")) {
      flushPara();
      blocks.push({ type: "title", text: line.slice(2).trim() });
    } else if (line.startsWith("## ")) {
      flushPara();
      blocks.push({ type: "heading", text: line.slice(3).trim() });
    } else if (line.trim() === "") {
      flushPara();
    } else {
      para += (para.length > 0 ? " " : "") + line;
    }
  }
  flushPara();
  return blocks;
}

/** Word-wrap `text` to fit `maxWidth` at the given font + size. Returns at
 *  least one line (empty string for empty input) so the caller's vertical
 *  layout stays predictable. */
export function wrapWords(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur.length === 0 ? w : `${cur} ${w}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      cur = candidate;
    } else {
      if (cur.length > 0) lines.push(cur);
      cur = w;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines.length > 0 ? lines : [""];
}

/** Render a list of blocks to a US Letter PDF and return the saved bytes. */
export async function renderBlocksToPdf(blocks: RenderedBlock[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 72;
  const contentTop = pageHeight - margin;
  const contentBottom = margin;
  const contentLeft = margin;
  const contentWidth = pageWidth - 2 * margin;

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = contentTop;

  const newPage = () => {
    page = pdf.addPage([pageWidth, pageHeight]);
    y = contentTop;
  };
  const drawLine = (text: string, font: PDFFont, size: number, leading: number) => {
    if (y - leading < contentBottom) newPage();
    page.drawText(text, { x: contentLeft, y: y - size, font, size });
    y -= leading;
  };

  for (const b of blocks) {
    if (b.type === "title") {
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

/** One-shot: substitute → parse → render → bytes. */
export async function renderTemplateToPdf(template: string, values: TemplateValues): Promise<Buffer> {
  const filled = substitute(template, values);
  const blocks = parseBlocks(filled);
  return renderBlocksToPdf(blocks);
}
