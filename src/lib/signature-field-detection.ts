// Auto-detection of signature-field placement on a PDF. Two sources:
//
//   1. AcroForm `/Sig` widgets — explicit, set by the PDF author. Confidence 1.0,
//      rectangle taken verbatim from the widget's /Rect.
//
//   2. Anchor-text heuristic — looks for "Signature:", "Sign here", "Signed by:",
//      "Initial:", "X____" patterns in the page text. For each match, we adjust
//      the proposed rectangle to avoid overlap with surrounding text:
//
//        - underline-snap     (0.95) — anchor + adjacent underscore run on the
//                                      same baseline → snap to its width
//        - whitespace-probe   (0.75) — anchor + adjacent empty space on the
//                                      same baseline → use the gap up to the
//                                      next text on the line or the page edge
//        - below-anchor-probe (0.85) — anchor alone on its line + vertical
//                                      whitespace below → place rectangle BELOW
//                                      the anchor (French/European convention:
//                                      "Signature" on its own line, sign below)
//        - shrink-to-fit      (0.50) — default rect iteratively shrunk to fit
//
// Strategy ordering: underline-snap → (if alone on line) below-anchor-probe →
// whitespace-probe → (if NOT alone on line) below-anchor-probe → shrink-to-fit.
// The "alone on line" check switches the heuristic between English forms
// ("Signature: _____" — fill in to the right) and European forms ("Signature"
// on its own line — sign below).
//
// Overlap is checked against pdfjs-extracted text bboxes — by the time a
// candidate is emitted, the rectangle does NOT overlap any text on the page.
// This is the safety contract: `overlapsText` is never `true` on a final
// candidate. If we can't adjust to fit, we drop the candidate entirely.
//
// The detector never silently picks a rectangle for you — `sign sign
// --auto-place` requires confidence >= 0.8 AND a unique top candidate before
// using it. Otherwise it errors with the full list so the caller chooses
// explicitly.

import { PDFDocument, PDFSignature } from "pdf-lib";

export type AdjustmentMethod =
  | "none"
  | "underline-snap"
  | "whitespace-probe"
  | "below-anchor-probe"
  | "shrink-to-fit";

export type FieldSource = "acroform" | `anchor:${string}`;

export type DetectedField = {
  /** 1-indexed page number. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  source: FieldSource;
  /** 0.0–1.0; 1.0 is an AcroForm /Sig widget, 0.5–0.95 are anchor-text matches. */
  confidence: number;
  adjustedFrom?: AdjustmentMethod;
  /** AcroForm field name (e.g., "Signature1"). */
  fieldName?: string;
  /** Anchor text that produced this candidate (e.g., "Signature:"). */
  anchorText?: string;
  /**
   * What kind of field this is. AcroForm /Sig widgets and `Signature:` /
   * `Sign here` etc. → "signature". Date anchors (`Date:`, `Date de
   * signature:`) → "date". Used by callers to filter which candidates apply
   * to a given action (`sign sign --auto-place` only considers signature
   * candidates; `sign pdf stamp-text` only considers date candidates).
   */
  category: "signature" | "date";
  /**
   * For `category: "date"` only. Set to `true` when text near the proposed
   * rectangle already matches a date pattern — so a caller stamping a date
   * can skip this candidate by default.
   */
  alreadyFilled?: boolean;
};

export type DetectionSummary = {
  pageCount: number;
  acroFormFields: number;
  anchorMatches: number;
  /** All candidates, sorted by confidence DESC. */
  candidates: DetectedField[];
  /** Convenience view: candidates filtered to `category: "signature"`. */
  signatureCandidates: DetectedField[];
  /** Convenience view: candidates filtered to `category: "date"`. */
  dateCandidates: DetectedField[];
  /**
   * Raw pdfjs text items per page. Only populated when `verbose: true` is
   * passed to `detectSignatureFields`. Used by `sign pdf detect-signature-field
   * --verbose` to diagnose why detection produced zero candidates.
   */
  textItemsByPage?: TextItem[][];
  /** Page dimensions (1-indexed: pageDimensions[pageNum-1]). Only with verbose. */
  pageDimensions?: Array<{ width: number; height: number }>;
};

/**
 * Detect candidate signature-field placements in a PDF. Returns candidates
 * sorted by confidence DESC; AcroForm widgets always rank above anchor-text
 * heuristics. Caller decides what to do with them — see `sign pdf
 * detect-signature-field` and `sign sign --auto-place`.
 */
export async function detectSignatureFields(
  pdfBytes: Buffer,
  opts: { verbose?: boolean } = {},
): Promise<DetectionSummary> {
  const acroForm = await findAcroFormSignatureFields(pdfBytes);
  const textPages = await extractTextItemsByPage(pdfBytes);
  const anchors = findAnchorCandidates(textPages);

  // De-duplicate: if an anchor-text candidate's rectangle overlaps an existing
  // AcroForm candidate on the same page, drop the anchor (the explicit field
  // wins). This keeps `--auto-place` deterministic when both sources agree.
  const filteredAnchors = anchors.filter((a) => {
    return !acroForm.some(
      (af) => af.page === a.page && rectanglesOverlap(af, a),
    );
  });

  const candidates = [...acroForm, ...filteredAnchors].sort(
    (a, b) => b.confidence - a.confidence,
  );

  const summary: DetectionSummary = {
    pageCount: textPages.length,
    acroFormFields: acroForm.length,
    anchorMatches: filteredAnchors.length,
    candidates,
    signatureCandidates: candidates.filter((c) => c.category === "signature"),
    dateCandidates: candidates.filter((c) => c.category === "date"),
  };

  if (opts.verbose) {
    summary.textItemsByPage = textPages.map((p) => p.items);
    summary.pageDimensions = textPages.map((p) => ({ width: p.width, height: p.height }));
  }
  return summary;
}

// ---------------------------------------------------------------------------
// AcroForm /Sig widgets (confidence 1.0)
// ---------------------------------------------------------------------------

async function findAcroFormSignatureFields(
  pdfBytes: Buffer,
): Promise<DetectedField[]> {
  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const form = pdf.getForm();
  const fields = form.getFields().filter((f): f is PDFSignature => f instanceof PDFSignature);

  const pages = pdf.getPages();
  const out: DetectedField[] = [];
  for (const field of fields) {
    const widgets = field.acroField.getWidgets();
    for (const widget of widgets) {
      const rect = widget.getRectangle(); // { x, y, width, height } in PDF user space
      if (rect.width <= 0 || rect.height <= 0) continue;

      // Map the widget back to a 1-indexed page number. The widget's /P entry
      // names its page; pdf-lib doesn't expose it directly so we iterate.
      const widgetRef = pdf.context.getObjectRef(widget.dict);
      let page = -1;
      for (let i = 0; i < pages.length; i++) {
        const annots = pages[i].node.Annots();
        if (!annots) continue;
        const refs = annots.asArray();
        if (widgetRef && refs.some((r) => r === widgetRef)) {
          page = i + 1;
          break;
        }
      }
      if (page < 1) continue;

      out.push({
        page,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        source: "acroform",
        confidence: 1.0,
        adjustedFrom: "none",
        fieldName: field.getName(),
        category: "signature",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// pdfjs text extraction
// ---------------------------------------------------------------------------

export type TextItem = {
  /** 1-indexed page. */
  page: number;
  text: string;
  /** PDF user-space lower-left corner (baseline for text). */
  x: number;
  y: number;
  width: number;
  height: number;
};

type PageContent = {
  items: TextItem[];
  /** Page dimensions in PDF points; used to clamp proposed rectangles. */
  width: number;
  height: number;
};

/**
 * Extract pdfjs text items for a single page (1-indexed). Exported helper
 * for consumers that need text positions for quality checks etc. — keeps
 * the pdfjs import surface centralized in this module.
 */
export async function extractPageTextItems(pdfBytes: Buffer, page: number): Promise<TextItem[]> {
  const all = await extractTextItemsByPage(pdfBytes);
  if (page < 1 || page > all.length) return [];
  return all[page - 1].items;
}

async function extractTextItemsByPage(pdfBytes: Buffer): Promise<PageContent[]> {
  // pdfjs uses CommonJS-style import; the `legacy/build/pdf.mjs` entry point
  // works under node's native ESM resolution.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(pdfBytes);
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: undefined,
  }).promise;

  const pages: PageContent[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    // view = [xMin, yMin, xMax, yMax]
    const view = page.view as number[];
    const pageWidth = view[2] - view[0];
    const pageHeight = view[3] - view[1];
    const tc = await page.getTextContent();
    const items: TextItem[] = [];
    for (const it of tc.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
      if (!it.str || !it.str.trim()) continue;
      const [, , , , e, f] = it.transform;
      items.push({
        page: i,
        text: it.str,
        x: e,
        y: f,
        width: it.width,
        height: it.height || 0,
      });
    }
    pages.push({ items, width: pageWidth, height: pageHeight });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Anchor-text heuristic
// ---------------------------------------------------------------------------

// Patterns we recognize. Each must match a *standalone* text item (we don't
// merge items across whitespace — pdfjs gives us per-item text, so "Signature"
// and ":" may be split). Trailing colons are optional. Case-insensitive.
type AnchorCategory = "signature" | "date";

const ANCHOR_PATTERNS: Array<{ regex: RegExp; label: string; category: AnchorCategory }> = [
  // Signature anchors
  { regex: /^\s*signature\s*:?\s*$/i, label: "Signature:", category: "signature" },
  { regex: /^\s*signed\s+by\s*:?\s*$/i, label: "Signed by:", category: "signature" },
  { regex: /^\s*sign\s+here\s*:?\s*$/i, label: "Sign here:", category: "signature" },
  { regex: /^\s*initial(s)?\s*:?\s*$/i, label: "Initial:", category: "signature" },
  { regex: /^\s*x\s*[_\-]{3,}\s*$/i, label: "X____", category: "signature" },
  // Date anchors — must end with a colon to disambiguate from sentences
  // containing "date". `Date:` alone matches most English forms; the longer
  // French/European variants below are commonly used on legal templates.
  { regex: /^\s*date\s*:\s*$/i, label: "Date:", category: "date" },
  { regex: /^\s*date\s+de\s+signature\s*:?\s*$/i, label: "Date de signature:", category: "date" },
  { regex: /^\s*date\s+d['’]effet\s*:?\s*$/i, label: "Date d'effet:", category: "date" },
  { regex: /^\s*date\s+d['’]entr[ée]e\s+en\s+vigueur\s*:?\s*$/i, label: "Date d'entrée en vigueur:", category: "date" },
];

// Patterns for "is this text a date?" — used to mark `alreadyFilled: true`
// when a date candidate's rectangle already contains a recognisable date.
const DATE_TEXT_PATTERNS: RegExp[] = [
  // Numeric: 12/05/2026, 12-05-2026, 12.05.2026, 2026-05-12, etc.
  /\b\d{1,4}\s*[\/\-\.]\s*\d{1,2}\s*[\/\-\.]\s*\d{1,4}\b/,
  // French textual: "12 mai 2026" / "1er janvier 2026"
  /\b\d{1,2}(er)?\s+(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)\s+\d{4}\b/i,
  // English textual: "May 12, 2026" / "12 May 2026"
  /\b(\d{1,2}\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\s*,?\s*\d{4}\b/i,
];

const DEFAULT_RECT_WIDTH = 180;
const DEFAULT_RECT_HEIGHT = 50;
const MIN_RECT_WIDTH = 60;
const MIN_RECT_HEIGHT = 20;
const ANCHOR_GAP = 6;
const PAGE_RIGHT_MARGIN = 36; // 0.5" — clamp right-side strategies to this

function findAnchorCandidates(textPages: PageContent[]): DetectedField[] {
  const out: DetectedField[] = [];
  for (let i = 0; i < textPages.length; i++) {
    const page = textPages[i];
    const pageNum = i + 1;
    for (const item of page.items) {
      for (const { regex, label, category } of ANCHOR_PATTERNS) {
        if (!regex.test(item.text)) continue;
        const candidate = proposeRectangleForAnchor(item, page);
        if (!candidate) continue;
        const field: DetectedField = {
          page: pageNum,
          x: candidate.x,
          y: candidate.y,
          width: candidate.width,
          height: candidate.height,
          source: `anchor:${label}`,
          confidence: candidate.confidence,
          adjustedFrom: candidate.method,
          anchorText: item.text.trim(),
          category,
        };
        if (category === "date") {
          // alreadyFilled: any text item on the same line as the anchor, to
          // the right of it, that matches a date pattern. Anchor-aware
          // (not just rect-aware) so we catch `Date: 12 mai 2026` even when
          // the proposed rectangle shrunk past the date.
          field.alreadyFilled = anchorHasNearbyDate(item, page.items);
        }
        out.push(field);
      }
    }
  }
  return out;
}

function anchorHasNearbyDate(anchor: TextItem, items: TextItem[]): boolean {
  // Same line as the anchor, to the right OR (if the anchor is alone on its
  // line) on the line directly below it. Either of those positions is the
  // conventional place an author would have written the date.
  const lineTolerance = Math.max(anchor.height * 0.6, 4);
  for (const item of items) {
    if (item === anchor) continue;
    const sameLineRight = Math.abs(item.y - anchor.y) <= lineTolerance && item.x >= anchor.x;
    const lineBelow = item.y < anchor.y - lineTolerance && item.y > anchor.y - anchor.height * 4 &&
      Math.abs(item.x - anchor.x) < anchor.width * 4;
    if (!sameLineRight && !lineBelow) continue;
    for (const re of DATE_TEXT_PATTERNS) {
      if (re.test(item.text)) return true;
    }
  }
  return false;
}

type ProposedRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  method: AdjustmentMethod;
};

/**
 * Given an anchor text item and the page it appears on, propose a rectangle
 * that does NOT overlap any text. Returns null if no rectangle of at least the
 * minimum size fits.
 *
 * Strategy ordering:
 *   1. underline-snap     — anchor + adjacent underscore run
 *   2. below-anchor-probe — if anchor is ALONE on its line, try below FIRST
 *   3. whitespace-probe   — anchor + clear space to the right on same line
 *   4. below-anchor-probe — if anchor has text to the right but whitespace-probe
 *                           failed (e.g., proposed rect overlapped line above),
 *                           fall back to below
 *   5. shrink-to-fit      — last resort: shrink width until no overlap
 */
function proposeRectangleForAnchor(
  anchor: TextItem,
  page: PageContent,
): ProposedRectangle | null {
  const pageItems = page.items;
  const lineTolerance = Math.max(anchor.height * 0.6, 4);
  const sameLine = pageItems.filter(
    (i) => i !== anchor && Math.abs(i.y - anchor.y) <= lineTolerance,
  );
  const rightOfAnchor = sameLine
    .filter((i) => i.x >= anchor.x + anchor.width - 2)
    .sort((a, b) => a.x - b.x);
  const isAloneOnLine = rightOfAnchor.length === 0;

  // ── 1. Underline snap ───────────────────────────────────────────────────
  const next = rightOfAnchor[0];
  if (next && /^[_\-\s]{3,}$/.test(next.text)) {
    const rect = {
      x: next.x,
      y: next.y - 4,
      width: next.width,
      height: Math.max(anchor.height * 1.8, DEFAULT_RECT_HEIGHT * 0.7),
      confidence: 0.95,
      method: "underline-snap" as AdjustmentMethod,
    };
    if (rect.width >= MIN_RECT_WIDTH && rect.height >= MIN_RECT_HEIGHT) {
      return rect;
    }
  }

  // ── 2. Below-anchor probe (priority path when anchor is alone on line) ──
  if (isAloneOnLine) {
    const below = tryBelowAnchorProbe(anchor, page, lineTolerance);
    if (below) return below;
  }

  // ── 3. Whitespace probe (right of anchor) ───────────────────────────────
  // xEnd is the FIRST of: next text on the line, OR the page right margin.
  const xStart = anchor.x + anchor.width + ANCHOR_GAP;
  const xEnd = Math.min(
    next ? next.x - 2 : xStart + DEFAULT_RECT_WIDTH * 1.5,
    page.width - PAGE_RIGHT_MARGIN,
  );
  const availableWidth = xEnd - xStart;
  if (availableWidth >= MIN_RECT_WIDTH) {
    const proposedHeight = Math.min(DEFAULT_RECT_HEIGHT, anchor.height * 2.5);
    const yBottom = anchor.y - 4;
    const rect = {
      x: xStart,
      y: yBottom,
      width: Math.min(availableWidth, DEFAULT_RECT_WIDTH),
      height: proposedHeight,
      confidence: availableWidth >= DEFAULT_RECT_WIDTH * 0.8 ? 0.75 : 0.60,
      method: "whitespace-probe" as AdjustmentMethod,
    };
    if (!rectangleOverlapsAnyText(rect, pageItems)) {
      return rect;
    }
  }

  // ── 4. Below-anchor probe (fallback when right-side failed) ─────────────
  if (!isAloneOnLine) {
    const below = tryBelowAnchorProbe(anchor, page, lineTolerance);
    if (below) return below;
  }

  // ── 5. Shrink-to-fit ────────────────────────────────────────────────────
  let rect = {
    x: anchor.x + anchor.width + ANCHOR_GAP,
    y: anchor.y - 4,
    width: Math.min(DEFAULT_RECT_WIDTH, page.width - PAGE_RIGHT_MARGIN - (anchor.x + anchor.width + ANCHOR_GAP)),
    height: DEFAULT_RECT_HEIGHT,
    confidence: 0.50,
    method: "shrink-to-fit" as AdjustmentMethod,
  };
  if (rect.width < MIN_RECT_WIDTH) return null;
  while (rectangleOverlapsAnyText(rect, pageItems)) {
    rect = { ...rect, width: rect.width * 0.9 };
    if (rect.width < MIN_RECT_WIDTH) return null;
  }
  if (rect.height < MIN_RECT_HEIGHT) return null;
  return rect;
}

/**
 * Place the rectangle BELOW the anchor: left-aligned with the anchor, extending
 * downward into vertical whitespace. This is the French/European convention
 * for a label on its own line ("Signature" followed by a blank signing area).
 *
 * Width: max(default, anchor.width × 3), clamped to page right margin.
 * Height: default, clamped by the vertical room down to the next text below
 *         (or the page bottom margin).
 */
function tryBelowAnchorProbe(
  anchor: TextItem,
  page: PageContent,
  lineTolerance: number,
): ProposedRectangle | null {
  // Find text below the anchor (lower y in PDF coords), sorted closest-first.
  const itemsBelow = page.items
    .filter((i) => i !== anchor && i.y < anchor.y - lineTolerance)
    .sort((a, b) => b.y - a.y);
  const yTop = anchor.y - 6;
  // The top edge of the nearest text below us (its baseline + ascender).
  const nextBelowTop = itemsBelow.length > 0
    ? itemsBelow[0].y + itemsBelow[0].height
    : 0;
  const verticalRoom = yTop - nextBelowTop;
  if (verticalRoom < MIN_RECT_HEIGHT) return null;

  const proposedHeight = Math.min(DEFAULT_RECT_HEIGHT, verticalRoom - 4);
  if (proposedHeight < MIN_RECT_HEIGHT) return null;

  const proposedWidth = Math.min(
    Math.max(DEFAULT_RECT_WIDTH, anchor.width * 3),
    page.width - PAGE_RIGHT_MARGIN - anchor.x,
  );
  if (proposedWidth < MIN_RECT_WIDTH) return null;

  const rect = {
    x: anchor.x,
    y: yTop - proposedHeight,
    width: proposedWidth,
    height: proposedHeight,
    confidence: 0.85,
    method: "below-anchor-probe" as AdjustmentMethod,
  };
  if (rectangleOverlapsAnyText(rect, page.items)) return null;
  return rect;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

type Rect = { x: number; y: number; width: number; height: number };

function rectanglesOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function rectangleOverlapsAnyText(rect: Rect, items: TextItem[]): boolean {
  // pdfjs gives text y as baseline, but the glyph extends both above (ascender)
  // and below (descender). Approximate the text bbox as
  // (x, y - 0.2*h, width, h) to include descenders.
  for (const item of items) {
    const itemRect: Rect = {
      x: item.x,
      y: item.y - item.height * 0.2,
      width: item.width,
      height: item.height,
    };
    if (rectanglesOverlap(rect, itemRect)) return true;
  }
  return false;
}
