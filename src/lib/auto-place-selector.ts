// Auto-place selector logic. Parses the `--auto-place` flag value into a
// mode, picks the right subset of detector candidates, and emits a single
// rectangle (or multiple, for `all`).
//
// Modes:
//
//   true | yes | 1   → "unique"   exactly one high-confidence candidate
//   first            → "first"    earliest page, top-of-page first
//   last             → "last"     latest page, bottom-of-page first
//   all              → "all"      every high-confidence candidate (multi-stamp)
//   page:N           → "page"     unique candidate on page N
//   index:N          → "index"    pick the Nth candidate (0-indexed from
//                                 the confidence-sorted list)
//
// Anything else throws `INVALID_AUTO_PLACE_VALUE`.
//
// The selector operates on the high-confidence subset (>=0.8) so callers
// don't have to filter explicitly. `unique`, `first`, `last`, `page`, and
// `index` each return exactly one rectangle. `all` returns N >= 1.
//
// On selection failure (no match, ambiguous, etc.) the selector returns
// `{ ok: false, errorCode, ...details }` rather than throwing — callers
// format the error envelope themselves so the existing CLI error shapes
// don't change.

import type { DetectedField } from "./signature-field-detection.js";

export type AutoPlaceMode =
  | { kind: "none" }
  | { kind: "unique" }
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "all" }
  | { kind: "page"; page: number }
  | { kind: "index"; index: number };

export type AutoPlaceErrorCode =
  | "INVALID_AUTO_PLACE_VALUE"
  | "AUTO_PLACE_NO_HIGH_CONFIDENCE"
  | "AUTO_PLACE_AMBIGUOUS"
  | "AUTO_PLACE_PAGE_NOT_FOUND"
  | "AUTO_PLACE_PAGE_AMBIGUOUS"
  | "AUTO_PLACE_INDEX_OUT_OF_RANGE";

export type AutoPlaceSuccess = {
  ok: true;
  mode: AutoPlaceMode;
  chosen: DetectedField[];
};

export type AutoPlaceFailure = {
  ok: false;
  mode: AutoPlaceMode;
  errorCode: AutoPlaceErrorCode;
  message: string;
  hint?: string;
  /** All candidates (low- + high-confidence) for the caller's error payload. */
  allCandidates: DetectedField[];
};

export type AutoPlaceResult = AutoPlaceSuccess | AutoPlaceFailure;

const HIGH_CONFIDENCE_THRESHOLD = 0.8;

const AUTO_PLACE_HELP =
  `Valid values: true | first | last | all | page:N | index:N. ` +
  `'true' requires exactly one high-confidence (>=0.8) candidate; ` +
  `'first'/'last' pick the earliest/latest by page+position; ` +
  `'all' stamps at every high-confidence candidate; ` +
  `'page:N' picks the unique candidate on page N; ` +
  `'index:N' picks the Nth candidate (0-indexed from the confidence-sorted list).`;

export function parseAutoPlaceMode(raw: string | null | undefined): AutoPlaceMode {
  if (!raw) return { kind: "none" };
  if (raw === "true" || raw === "yes" || raw === "1") return { kind: "unique" };
  if (raw === "false" || raw === "no" || raw === "0") return { kind: "none" };
  if (raw === "first") return { kind: "first" };
  if (raw === "last") return { kind: "last" };
  if (raw === "all") return { kind: "all" };
  const pageMatch = raw.match(/^page:(\d+)$/);
  if (pageMatch) {
    const page = parseInt(pageMatch[1], 10);
    if (page < 1) {
      throw new InvalidAutoPlaceValue(raw, `Page numbers are 1-indexed; got ${page}.`);
    }
    return { kind: "page", page };
  }
  const indexMatch = raw.match(/^index:(\d+)$/);
  if (indexMatch) {
    const index = parseInt(indexMatch[1], 10);
    return { kind: "index", index };
  }
  throw new InvalidAutoPlaceValue(raw, AUTO_PLACE_HELP);
}

export class InvalidAutoPlaceValue extends Error {
  constructor(public raw: string, public hint: string) {
    super(`Invalid --auto-place value: ${JSON.stringify(raw)}. ${hint}`);
    this.name = "InvalidAutoPlaceValue";
  }
}

/**
 * Select candidate(s) per the mode. `candidates` is the raw detector output;
 * we filter to high-confidence inside this function so callers don't have
 * to pre-filter.
 */
export function selectAutoPlaceCandidates(
  candidates: DetectedField[],
  mode: AutoPlaceMode,
): AutoPlaceResult {
  if (mode.kind === "none") {
    return { ok: true, mode, chosen: [] };
  }
  const high = candidates.filter((c) => c.confidence >= HIGH_CONFIDENCE_THRESHOLD);
  if (high.length === 0) {
    return {
      ok: false,
      mode,
      errorCode: "AUTO_PLACE_NO_HIGH_CONFIDENCE",
      message: `--auto-place found no high-confidence (>= ${HIGH_CONFIDENCE_THRESHOLD}) signature fields in the PDF.`,
      hint: candidates.length > 0
        ? `Low-confidence candidates were found; pass --image-* with one of them or rerun without --auto-place.`
        : `No AcroForm /Sig fields and no anchor text (Signature:, Sign here, etc.) detected. Pass --image-page/--image-x/--image-y/--image-width/--image-height explicitly.`,
      allCandidates: candidates,
    };
  }

  switch (mode.kind) {
    case "unique": {
      if (high.length > 1) {
        return {
          ok: false,
          mode,
          errorCode: "AUTO_PLACE_AMBIGUOUS",
          message: `--auto-place=true found ${high.length} high-confidence candidates; refusing to pick one.`,
          hint:
            `Use --auto-place first | last | all | page:N | index:N to disambiguate, or pass ` +
            `--image-* explicitly with one of the rectangles in details.candidates. ` +
            `\`sign pdf detect-signature-field --pdf <path>\` lists them.`,
          allCandidates: candidates,
        };
      }
      return { ok: true, mode, chosen: high };
    }
    case "first": {
      // Earliest page, then highest y (top of page in PDF coords).
      const sorted = [...high].sort((a, b) => a.page - b.page || b.y - a.y);
      return { ok: true, mode, chosen: [sorted[0]] };
    }
    case "last": {
      // Latest page, then lowest y (bottom of page in PDF coords).
      const sorted = [...high].sort((a, b) => b.page - a.page || a.y - b.y);
      return { ok: true, mode, chosen: [sorted[0]] };
    }
    case "all": {
      return { ok: true, mode, chosen: high };
    }
    case "page": {
      const onPage = high.filter((c) => c.page === mode.page);
      if (onPage.length === 0) {
        return {
          ok: false,
          mode,
          errorCode: "AUTO_PLACE_PAGE_NOT_FOUND",
          message: `--auto-place page:${mode.page} found no high-confidence candidates on page ${mode.page}.`,
          hint:
            `Candidates exist on pages: ${[...new Set(high.map((c) => c.page))].sort((a, b) => a - b).join(", ")}. ` +
            `Pick one of those, use --auto-place all, or pass --image-* explicitly.`,
          allCandidates: candidates,
        };
      }
      if (onPage.length > 1) {
        return {
          ok: false,
          mode,
          errorCode: "AUTO_PLACE_PAGE_AMBIGUOUS",
          message: `--auto-place page:${mode.page} found ${onPage.length} high-confidence candidates on page ${mode.page}; refusing to pick one.`,
          hint:
            `Use --auto-place index:N to pick a specific candidate (0-indexed from details.candidates), ` +
            `or pass --image-* explicitly.`,
          allCandidates: candidates,
        };
      }
      return { ok: true, mode, chosen: onPage };
    }
    case "index": {
      if (mode.index >= high.length) {
        return {
          ok: false,
          mode,
          errorCode: "AUTO_PLACE_INDEX_OUT_OF_RANGE",
          message: `--auto-place index:${mode.index} is out of range; only ${high.length} high-confidence candidate(s) exist.`,
          hint: `Valid indices: 0..${high.length - 1}. See details.candidates for the order (sorted by confidence DESC).`,
          allCandidates: candidates,
        };
      }
      return { ok: true, mode, chosen: [high[mode.index]] };
    }
    default: {
      // Exhaustiveness check. mode.kind === "none" already handled above.
      const _exhaustive: never = mode;
      throw new Error(`unreachable: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Render a one-line summary of the chosen rectangle(s) for stderr logging. */
export function formatAutoPlaceChoice(chosen: DetectedField[]): string {
  if (chosen.length === 1) {
    const c = chosen[0];
    return (
      `${c.source} (confidence ${c.confidence.toFixed(2)}, adjustedFrom=${c.adjustedFrom ?? "none"}) ` +
      `at page=${c.page} x=${c.x.toFixed(0)} y=${c.y.toFixed(0)} w=${c.width.toFixed(0)} h=${c.height.toFixed(0)}`
    );
  }
  const pages = [...new Set(chosen.map((c) => c.page))].sort((a, b) => a - b).join(",");
  return `${chosen.length} candidates across page(s) ${pages}`;
}
