// Heuristic quality checks for a stamped signature. These run BEFORE the
// PAdES envelope seals the PDF (and again on `pdf stamp verify`), so a caller
// gets a chance to bail before producing an unsigned-but-ugly final file.
//
// What we flag:
//
//   1. ASPECT_RATIO_DISTORTED — the image was drawn at an aspect ratio that
//      differs from its natural one by more than 5%. Fires only when
//      `preserveAspectRatio: false` was passed; with the default-true the
//      flag never trips.
//
//   2. STAMP_OUTSIZED_VS_TEXT — the stamp height is more than 5× the median
//      text line height on the page. Almost always means the agent picked a
//      rectangle too large for body-text-sized content.
//
//   3. STAMP_OVERLAPS_TEXT — the stamp rectangle intersects any text bbox on
//      the page. Detection-time auto-place rejects these candidates already,
//      but explicit --image-* coords could still produce an overlap.
//
//   4. STAMP_OFF_PAGE — any edge of the stamp falls outside the page bounds
//      (within a 1pt tolerance to account for sub-pixel rounding).
//
// Output: `Warning[]` with `code`, human-readable `message`, and a `severity`
// hint (`warning` shows on stderr, `error` causes `--strict-quality true` to
// abort). Caller decides what to do — these are advisory, not enforced.

import { PDFDocument } from "pdf-lib";

export type QualityWarningCode =
  | "ASPECT_RATIO_DISTORTED"
  | "STAMP_OUTSIZED_VS_TEXT"
  | "STAMP_OVERLAPS_TEXT"
  | "STAMP_OFF_PAGE";

export type QualityWarning = {
  code: QualityWarningCode;
  severity: "warning" | "error";
  message: string;
  /** Extra context for callers that want to render structured details. */
  details?: Record<string, unknown>;
};

export type AssessStampInput = {
  pdfBytes: Buffer;
  /** 1-indexed page. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Natural dimensions of the source image. When provided, we can check
   * whether the stamp rectangle preserves the image's aspect ratio.
   */
  imageNaturalWidth?: number;
  imageNaturalHeight?: number;
};

const ASPECT_TOLERANCE = 0.05; // 5%
const OUTSIZED_RATIO = 5; // stamp.h / median text.h
const OVERLAP_TOLERANCE = 0; // require strict non-intersection
const OFF_PAGE_TOLERANCE = 1;

export async function assessStampQuality(input: AssessStampInput): Promise<QualityWarning[]> {
  const out: QualityWarning[] = [];

  // Page geometry from pdf-lib (no pdfjs round-trip needed for this).
  const pdf = await PDFDocument.load(input.pdfBytes, { ignoreEncryption: true });
  const pages = pdf.getPages();
  if (input.page < 1 || input.page > pages.length) {
    return out; // page out of range — caller surfaces this separately
  }
  const page = pages[input.page - 1];
  const { width: pageW, height: pageH } = page.getSize();

  // ── STAMP_OFF_PAGE ──────────────────────────────────────────────────────
  if (
    input.x < -OFF_PAGE_TOLERANCE ||
    input.y < -OFF_PAGE_TOLERANCE ||
    input.x + input.width > pageW + OFF_PAGE_TOLERANCE ||
    input.y + input.height > pageH + OFF_PAGE_TOLERANCE
  ) {
    out.push({
      code: "STAMP_OFF_PAGE",
      severity: "error",
      message:
        `Stamp rectangle (x=${input.x.toFixed(1)} y=${input.y.toFixed(1)} ` +
        `w=${input.width.toFixed(1)} h=${input.height.toFixed(1)}) extends ` +
        `beyond page ${input.page} bounds (${pageW.toFixed(0)} × ${pageH.toFixed(0)}).`,
      details: { pageWidth: pageW, pageHeight: pageH },
    });
  }

  // ── ASPECT_RATIO_DISTORTED ──────────────────────────────────────────────
  if (input.imageNaturalWidth && input.imageNaturalHeight) {
    const naturalAspect = input.imageNaturalWidth / input.imageNaturalHeight;
    const drawnAspect = input.width / input.height;
    const ratio = drawnAspect / naturalAspect;
    if (Math.abs(ratio - 1) > ASPECT_TOLERANCE) {
      const pct = ((ratio - 1) * 100).toFixed(0);
      out.push({
        code: "ASPECT_RATIO_DISTORTED",
        severity: "warning",
        message:
          `Stamp aspect ratio (${drawnAspect.toFixed(2)}) differs from the ` +
          `image's natural aspect (${naturalAspect.toFixed(2)}) by ${pct}%. ` +
          `The image will appear stretched. Default --preserve-aspect-ratio true ` +
          `avoids this; pass it explicitly or shrink the box to match the image's shape.`,
        details: {
          naturalAspect,
          drawnAspect,
          naturalWidth: input.imageNaturalWidth,
          naturalHeight: input.imageNaturalHeight,
        },
      });
    }
  }

  // ── STAMP_OUTSIZED_VS_TEXT + STAMP_OVERLAPS_TEXT (via pdfjs) ────────────
  // Both need page text positions. Extract them once and run both checks.
  // pdfjs is the only path we have for text-bbox info, and signature-field-
  // detection already imports it; reusing here keeps the dep surface flat.
  try {
    const { extractPageTextItems } = await import("./signature-field-detection.js");
    const items = await extractPageTextItems(input.pdfBytes, input.page);
    if (items.length > 0) {
      const heights = items.map((i) => i.height).filter((h) => h > 0).sort((a, b) => a - b);
      const medianHeight = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : 0;
      if (medianHeight > 0 && input.height > medianHeight * OUTSIZED_RATIO) {
        out.push({
          code: "STAMP_OUTSIZED_VS_TEXT",
          severity: "warning",
          message:
            `Stamp height ${input.height.toFixed(0)}pt is ${(input.height / medianHeight).toFixed(1)}× the median body-text line ` +
            `(${medianHeight.toFixed(1)}pt). The signature may look out of proportion ` +
            `to the surrounding content. Consider shrinking --image-height.`,
          details: { stampHeight: input.height, medianTextHeight: medianHeight },
        });
      }
      const overlapping = items.filter((i) => {
        const r1 = { x: input.x, y: input.y, w: input.width, h: input.height };
        const r2 = { x: i.x, y: i.y - i.height * 0.2, w: i.width, h: i.height };
        const overlap = !(
          r1.x + r1.w <= r2.x + OVERLAP_TOLERANCE ||
          r2.x + r2.w <= r1.x + OVERLAP_TOLERANCE ||
          r1.y + r1.h <= r2.y + OVERLAP_TOLERANCE ||
          r2.y + r2.h <= r1.y + OVERLAP_TOLERANCE
        );
        return overlap;
      });
      if (overlapping.length > 0) {
        out.push({
          code: "STAMP_OVERLAPS_TEXT",
          severity: "warning",
          message:
            `Stamp rectangle overlaps ${overlapping.length} text bbox(es) on page ${input.page}. ` +
            `The signature will be drawn on top of body text. Consider shifting --image-x/--image-y ` +
            `or using --auto-place which rejects overlapping candidates by default.`,
          details: { overlappingTextSamples: overlapping.slice(0, 3).map((i) => i.text) },
        });
      }
    }
  } catch {
    // pdfjs failed (encrypted, unusual encoding, etc.) — silently skip the
    // text-based checks. STAMP_OFF_PAGE + ASPECT_RATIO_DISTORTED still ran.
  }

  return out;
}