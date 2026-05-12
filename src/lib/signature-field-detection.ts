// Auto-detection of signature-field placement on a PDF. Two sources:
//
//   1. AcroForm `/Sig` widgets — explicit, set by the PDF author. Confidence 1.0,
//      rectangle taken verbatim from the widget's /Rect.
//
//   2. Anchor-text heuristic — looks for "Signature:", "Sign here", "Signed by:",
//      "Initial:", "X____" patterns in the page text. For each match, we adjust
//      the proposed rectangle to avoid overlap with surrounding text:
//
//        - underline-snap   (0.95) — if there's an underscore run at the anchor's
//                                    baseline, snap to its width
//        - whitespace-probe (0.75) — use the whitespace between anchor and the
//                                    next text on the line
//        - shrink-to-fit    (0.50) — start with a default rect, iteratively
//                                    shrink until no overlap; reject if too small
//
// Overlap is checked against pdfjs-extracted text bboxes — by the time a
// candidate is emitted, the rectangle does NOT overlap any text on the page.
// This is the safety contract: `overlapsText` is never `true` on a final
// candidate. If we can't adjust to fit, we drop the candidate entirely.
//
// The detector never silently picks a rectangle for you — `sign sign --field
// auto` requires confidence >= 0.8 AND a unique top candidate before using it.
// Otherwise it errors with the full list so the caller chooses explicitly.

import { PDFDocument, PDFSignature } from "pdf-lib";

export type AdjustmentMethod =
  | "none"
  | "underline-snap"
  | "whitespace-probe"
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
};

export type DetectionSummary = {
  pageCount: number;
  acroFormFields: number;
  anchorMatches: number;
  candidates: DetectedField[];
};

/**
 * Detect candidate signature-field placements in a PDF. Returns candidates
 * sorted by confidence DESC; AcroForm widgets always rank above anchor-text
 * heuristics. Caller decides what to do with them — see `sign pdf
 * detect-signature-field` and `sign sign --field auto`.
 */
export async function detectSignatureFields(
  pdfBytes: Buffer,
): Promise<DetectionSummary> {
  const acroForm = await findAcroFormSignatureFields(pdfBytes);
  const textPages = await extractTextItemsByPage(pdfBytes);
  const anchors = findAnchorCandidates(textPages);

  // De-duplicate: if an anchor-text candidate's rectangle overlaps an existing
  // AcroForm candidate on the same page, drop the anchor (the explicit field
  // wins). This keeps `--field auto` deterministic when both sources agree.
  const filteredAnchors = anchors.filter((a) => {
    return !acroForm.some(
      (af) => af.page === a.page && rectanglesOverlap(af, a),
    );
  });

  const candidates = [...acroForm, ...filteredAnchors].sort(
    (a, b) => b.confidence - a.confidence,
  );

  return {
    pageCount: textPages.length,
    acroFormFields: acroForm.length,
    anchorMatches: filteredAnchors.length,
    candidates,
  };
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
  /** PDF user-space lower-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
};

async function extractTextItemsByPage(pdfBytes: Buffer): Promise<TextItem[][]> {
  // pdfjs uses CommonJS-style import; the `legacy/build/pdf.mjs` entry point
  // works under node's native ESM resolution.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Silence pdfjs's worker message — we run it in the same thread.
  // (No worker setup needed in node; pdfjs auto-falls-back.)
  const data = new Uint8Array(pdfBytes);
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    // Don't try to fetch standard fonts from disk — we don't need glyphs, just
    // positions.
    standardFontDataUrl: undefined,
  }).promise;

  const pages: TextItem[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items: TextItem[] = [];
    for (const it of tc.items as Array<{ str: string; transform: number[]; width: number; height: number }>) {
      // transform = [a, b, c, d, e, f]; (e, f) is the position; height is the
      // font size; width is the rendered width.
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
    pages.push(items);
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Anchor-text heuristic
// ---------------------------------------------------------------------------

// Patterns we recognize. Each must match a *standalone* text item (we don't
// merge items across whitespace — pdfjs gives us per-item text, so "Signature"
// and ":" may be split). Trailing colons are optional. Case-insensitive.
const ANCHOR_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /^\s*signature\s*:?\s*$/i, label: "Signature:" },
  { regex: /^\s*signed\s+by\s*:?\s*$/i, label: "Signed by:" },
  { regex: /^\s*sign\s+here\s*:?\s*$/i, label: "Sign here:" },
  { regex: /^\s*initial(s)?\s*:?\s*$/i, label: "Initial:" },
  { regex: /^\s*x\s*[_\-]{3,}\s*$/i, label: "X____" },
];

// Default proposed rectangle for an anchor when we have no better signal.
const DEFAULT_RECT_WIDTH = 180;
const DEFAULT_RECT_HEIGHT = 50;
const MIN_RECT_WIDTH = 60;
const MIN_RECT_HEIGHT = 20;
const ANCHOR_GAP = 6; // points between anchor text and proposed rectangle

function findAnchorCandidates(textPages: TextItem[][]): DetectedField[] {
  const out: DetectedField[] = [];
  for (let i = 0; i < textPages.length; i++) {
    const items = textPages[i];
    const pageNum = i + 1;
    for (const item of items) {
      for (const { regex, label } of ANCHOR_PATTERNS) {
        if (!regex.test(item.text)) continue;
        const candidate = proposeRectangleForAnchor(item, items);
        if (!candidate) continue;
        out.push({
          page: pageNum,
          x: candidate.x,
          y: candidate.y,
          width: candidate.width,
          height: candidate.height,
          source: `anchor:${label}`,
          confidence: candidate.confidence,
          adjustedFrom: candidate.method,
          anchorText: item.text.trim(),
        });
      }
    }
  }
  return out;
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
 * Given an anchor text item and all text items on the same page, propose a
 * rectangle to the right of the anchor that does NOT overlap any text. Returns
 * null if no rectangle of at least the minimum size fits.
 */
function proposeRectangleForAnchor(
  anchor: TextItem,
  pageItems: TextItem[],
): ProposedRectangle | null {
  // Same-line predicate: another item whose baseline y is within half the
  // anchor's height. pdfjs reports y as the baseline (lower-left of glyph box).
  const lineTolerance = Math.max(anchor.height * 0.6, 4);
  const sameLine = pageItems.filter(
    (i) => i !== anchor && Math.abs(i.y - anchor.y) <= lineTolerance,
  );

  // Items to the right of the anchor on the same line, sorted by x.
  const rightOfAnchor = sameLine
    .filter((i) => i.x >= anchor.x + anchor.width - 2)
    .sort((a, b) => a.x - b.x);

  // ── 1. Underline snap ───────────────────────────────────────────────────
  // If the next item to the right is mostly underscores (or dashes), use its
  // rectangle. That's an explicit signature-line — high confidence.
  const next = rightOfAnchor[0];
  if (next && /^[_\-\s]{3,}$/.test(next.text)) {
    const rect = {
      x: next.x,
      // baseline + a few points down → bottom of rectangle
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

  // ── 2. Whitespace probe ─────────────────────────────────────────────────
  // Start at anchor.x + anchor.width + gap. Right edge: the next text on the
  // line, or the page right margin. We approximate the page right edge as
  // anchor.x + anchor.width + DEFAULT_RECT_WIDTH * 1.5 when there's no item to
  // the right — won't run off the page for any sensible anchor placement.
  const xStart = anchor.x + anchor.width + ANCHOR_GAP;
  const xEnd = next ? next.x - 2 : xStart + DEFAULT_RECT_WIDTH * 1.5;
  const availableWidth = xEnd - xStart;

  if (availableWidth >= MIN_RECT_WIDTH) {
    // Vertical: extend below the anchor's baseline by ~1.5 line heights.
    // Check items above and below for clipping.
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

  // ── 3. Shrink-to-fit ────────────────────────────────────────────────────
  // Start with the default, shrink width by 10% until no overlap or below
  // minimum. Reject if we can't fit.
  let rect = {
    x: anchor.x + anchor.width + ANCHOR_GAP,
    y: anchor.y - 4,
    width: DEFAULT_RECT_WIDTH,
    height: DEFAULT_RECT_HEIGHT,
    confidence: 0.50,
    method: "shrink-to-fit" as AdjustmentMethod,
  };
  while (rectangleOverlapsAnyText(rect, pageItems)) {
    rect = { ...rect, width: rect.width * 0.9 };
    if (rect.width < MIN_RECT_WIDTH) return null;
  }
  if (rect.width < MIN_RECT_WIDTH || rect.height < MIN_RECT_HEIGHT) return null;
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
