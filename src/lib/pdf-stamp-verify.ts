// Verify that a PDF carries an image stamp at the expected position. Mirror
// of `stampImageOnPdf` — same coordinates in, ok/missing/wrong_position out.
// Item 3 of the product-readiness feedback.
//
// Detection strategy: pdf-lib renders stamps as a deterministic content-stream
// pattern:
//
//   q
//   <width> 0 0 <height> <x> <y> cm
//   /<imageName> Do
//   Q
//
// We decode the page's content stream (decompressing FlateDecode if needed)
// and scan for that pattern, then compare every match to the expected box
// within ±1pt tolerance. Stamps produced by other tools may use compounded
// transforms — we deliberately do not handle that yet; the verifier only
// claims to confirm stamps it itself could have produced.

import { PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";

export type ExpectedStampPosition = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StampFound = {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  imageName: string;
};

export type StampVerifyVerdict = "ok" | "missing" | "wrong_position";

export type StampVerifyReport = {
  verdict: StampVerifyVerdict;
  expected: ExpectedStampPosition;
  /** Best (closest) stamp candidate found on the expected page, or null when
   *  no image was drawn on that page at all. */
  found: StampFound | null;
  /** Every image draw the parser found on the target page — handy for
   *  debugging when verdict is wrong_position. */
  candidates: StampFound[];
  detail: string;
};

/** Tolerance in PDF points (1pt = 1/72 inch). Tight by design — stamps from
 *  our own tool are bit-exact, so anything farther than ±1pt is drift or a
 *  different stamp. */
const POSITION_TOLERANCE_PT = 1;

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= POSITION_TOLERANCE_PT;
}

function matchesExpected(found: StampFound, expected: ExpectedStampPosition): boolean {
  return found.page === expected.page
    && approxEqual(found.x, expected.x)
    && approxEqual(found.y, expected.y)
    && approxEqual(found.width, expected.width)
    && approxEqual(found.height, expected.height);
}

// 2D affine matrix in PDF order: [a b c d e f] meaning
//   [ a  b  0 ]
//   [ c  d  0 ]
//   [ e  f  1 ]
// Composition: M_total = M_existing × M_new (PDF appends new transforms on the right).
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m;
  const [a2, b2, c2, d2, e2, f2] = n;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

/** Walk PDF content-stream operators, tracking the graphics-state stack +
 *  current transformation matrix. When we hit `/Name Do` for an image
 *  XObject, the effective CTM is the image's placement on the page (since
 *  images are drawn in a 1×1 box at origin then transformed).
 *
 *  Limitation: we only handle unrotated transforms (b=0, c=0 in the final
 *  CTM). Rotated/sheared stamps would need a full matrix decomposition
 *  which is overkill for an MVP — the stamps `stampImageOnPdf` produces
 *  are always axis-aligned, and the verifier is meant to be the matching
 *  half of that pair. */
function extractImageDraws(content: string, imageNames: Set<string>, page: number): StampFound[] {
  const found: StampFound[] = [];
  // Strip comments + tokenize on whitespace. PDF tokens are simple enough
  // for the operators we care about (cm, q, Q, Do, /Name). String/hex/array
  // literals could trip a naive split, but content-stream ops don't put
  // them in positions that matter for matrix/Do detection.
  const tokens = content
    .replace(/%[^\n]*/g, "") // drop PDF comments
    .split(/\s+/)
    .filter((t) => t.length > 0);

  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let lastName: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "q") {
      stack.push(ctm);
    } else if (t === "Q") {
      ctm = stack.pop() ?? IDENTITY;
    } else if (t === "cm" && i >= 6) {
      // Six numeric operands precede `cm`. PDF concatenation rule: the new
      // operand matrix is PRE-multiplied into the CTM (M_op on the left),
      // so that a point p transformed by the accumulated CTM goes through
      // earlier-emitted operators first.
      const parts = tokens.slice(i - 6, i).map(Number);
      if (parts.every((n) => Number.isFinite(n))) {
        ctm = multiply(parts as Matrix, ctm);
      }
    } else if (t.startsWith("/")) {
      // Remember the last name token — `/Foo Do` uses it.
      lastName = t.slice(1);
    } else if (t === "Do" && lastName !== null && imageNames.has(lastName)) {
      const [a, b, c, d, e, f] = ctm;
      // Only report axis-aligned stamps. A rotated/sheared image has
      // non-zero b or c; we'd need to decompose those, so skip for now.
      if (Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6) {
        found.push({
          page,
          x: e,
          y: f,
          width: a,
          height: d,
          imageName: lastName,
        });
      }
      lastName = null;
    } else if (t === "Do") {
      lastName = null;
    }
  }
  return found;
}

function imageXObjectNames(pdf: PDFDocument, pageIndex: number): Set<string> {
  const names = new Set<string>();
  const page = pdf.getPages()[pageIndex];
  // Resources / XObject is a dict whose entries map to (in)direct refs at
  // image XObjects. We only want ones with /Subtype /Image.
  const resources = page.node.Resources();
  const xobjects = resources?.lookup(PDFName.of("XObject"));
  if (!xobjects || typeof (xobjects as { keys?: () => unknown }).keys !== "function") return names;
  const keys = (xobjects as unknown as { keys(): PDFName[] }).keys();
  for (const key of keys) {
    const obj = (xobjects as unknown as { lookup(k: PDFName): unknown }).lookup(key);
    if (obj && typeof obj === "object" && "dict" in obj) {
      const dict = (obj as { dict: { get(name: PDFName): unknown } }).dict;
      const subtype = dict.get(PDFName.of("Subtype"));
      if (subtype && String(subtype) === "/Image") {
        names.add(key.toString().replace(/^\//, ""));
      }
    }
  }
  return names;
}

function decodePageContent(pdf: PDFDocument, pageIndex: number): string {
  const page = pdf.getPages()[pageIndex];
  // normalize() is void; it mutates the node so subsequent Contents() works
  // even on imported PDFs where contents are an array of streams.
  page.node.normalize();
  const contentsRef = page.node.Contents();
  if (!contentsRef) return "";
  const chunks: string[] = [];
  // Contents can be a single stream or an array of streams.
  const streams = "asArray" in contentsRef
    ? (contentsRef as { asArray(): unknown[] }).asArray()
    : [contentsRef];
  for (const raw of streams) {
    // Resolve indirect refs (the common case for normalized page contents,
    // which is an array of PDFRefs pointing at the actual stream objects).
    const s = raw instanceof PDFRef ? pdf.context.lookup(raw) : raw;
    if (s instanceof PDFRawStream) {
      const decoded = decodePDFRawStream(s).decode();
      chunks.push(Buffer.from(decoded).toString("latin1"));
    } else if (s && typeof s === "object" && "contents" in s) {
      const inner = (s as { contents: Uint8Array }).contents;
      chunks.push(Buffer.from(inner).toString("latin1"));
    }
  }
  return chunks.join("\n");
}

export async function verifyPdfStamp(
  pdfBytes: Buffer,
  expected: ExpectedStampPosition,
): Promise<StampVerifyReport> {
  if (expected.page < 1) {
    throw new Error(`verifyPdfStamp: page is 1-indexed; got ${expected.page}`);
  }
  const pdf = await PDFDocument.load(pdfBytes);
  const pages = pdf.getPages();
  if (expected.page > pages.length) {
    return {
      verdict: "missing",
      expected,
      found: null,
      candidates: [],
      detail: `Page ${expected.page} is out of range (PDF has ${pages.length} page${pages.length === 1 ? "" : "s"})`,
    };
  }
  const pageIndex = expected.page - 1;
  const imageNames = imageXObjectNames(pdf, pageIndex);
  if (imageNames.size === 0) {
    return {
      verdict: "missing",
      expected,
      found: null,
      candidates: [],
      detail: `No image XObjects on page ${expected.page}`,
    };
  }
  const content = decodePageContent(pdf, pageIndex);
  const candidates = extractImageDraws(content, imageNames, expected.page);
  if (candidates.length === 0) {
    return {
      verdict: "missing",
      expected,
      found: null,
      candidates: [],
      detail: `No image-draw operations matched the verifier's pattern on page ${expected.page}. The PDF may use compounded transforms or rotation — not yet supported.`,
    };
  }
  // Pick the candidate with the smallest L∞ distance from expected; that's
  // what we report as `found`, regardless of whether it passes the match.
  let best = candidates[0];
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.max(
      Math.abs(c.x - expected.x),
      Math.abs(c.y - expected.y),
      Math.abs(c.width - expected.width),
      Math.abs(c.height - expected.height),
    );
    if (d < bestDist) { best = c; bestDist = d; }
  }
  if (candidates.some((c) => matchesExpected(c, expected))) {
    return {
      verdict: "ok",
      expected,
      found: best,
      candidates,
      detail: `Image '${best.imageName}' drawn at the expected box within ±${POSITION_TOLERANCE_PT}pt.`,
    };
  }
  return {
    verdict: "wrong_position",
    expected,
    found: best,
    candidates,
    detail:
      `Page ${expected.page} has ${candidates.length} image draw${candidates.length === 1 ? "" : "s"}, ` +
      `but none match expected x=${expected.x},y=${expected.y},w=${expected.width},h=${expected.height} ` +
      `within ±${POSITION_TOLERANCE_PT}pt. Closest: x=${best.x},y=${best.y},w=${best.width},h=${best.height}.`,
  };
}

export function stampVerifyExitCode(verdict: StampVerifyVerdict): 0 | 3 | 4 {
  switch (verdict) {
    case "ok":              return 0;
    case "wrong_position":  return 3;
    case "missing":         return 4;
  }
}
