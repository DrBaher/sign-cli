import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { stampImageOnPdf } from "../lib/pdf-image-stamp.js";
import { assessStampQuality } from "../lib/stamp-quality.js";
import { encodePng, decodePng, type PngInfo } from "../lib/png-bounds.js";

async function blankPdf(width = 612, height = 792): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

async function busyPdf(): Promise<Buffer> {
  // 800-pt-tall page with 25 lines of 12pt text. Used for outsize / overlap tests.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  for (let y = 700; y >= 200; y -= 20) {
    page.drawText(`Body text line at y=${y}`, { x: 72, y, font: helv, size: 12 });
  }
  return Buffer.from(await doc.save());
}

function pngOfSize(width: number, height: number): Buffer {
  // Solid green RGBA PNG of the given dims.
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 0; pixels[i + 1] = 200; pixels[i + 2] = 0; pixels[i + 3] = 255;
  }
  const info: PngInfo = { width, height, channels: 4, pixels };
  return encodePng(info);
}

// ─── stampImageOnPdf aspect-ratio behavior ────────────────────────────────

test("stampImageOnPdf: preserveAspectRatio default (true) shrinks-to-fit, top-left aligned", async () => {
  // 10×100 image (1:10 aspect) into 200×50 box (4:1 aspect).
  // Expected: scale = min(200/10, 50/100) = 0.5 → draw 5×50 at (x, y+50-50)=(x, y).
  const pdf = await blankPdf();
  const stamped = await stampImageOnPdf(
    pdf,
    { kind: "buffer", data: pngOfSize(10, 100), mime: "image/png" },
    { page: 1, x: 100, y: 100, width: 200, height: 50 },
  );
  const { verifyPdfStamp } = await import("../lib/pdf-stamp-verify.js");
  const report = await verifyPdfStamp(stamped, { page: 1, x: 100, y: 100, width: 5, height: 50 });
  assert.equal(report.verdict, "ok", `expected ok with drawn 5×50 at (100,100); got ${report.verdict} ${JSON.stringify(report.found)}`);
});

test("stampImageOnPdf: preserveAspectRatio:false stretches to fill", async () => {
  const pdf = await blankPdf();
  const stamped = await stampImageOnPdf(
    pdf,
    { kind: "buffer", data: pngOfSize(10, 100), mime: "image/png" },
    { page: 1, x: 100, y: 100, width: 200, height: 50 },
    { preserveAspectRatio: false },
  );
  const { verifyPdfStamp } = await import("../lib/pdf-stamp-verify.js");
  const report = await verifyPdfStamp(stamped, { page: 1, x: 100, y: 100, width: 200, height: 50 });
  assert.equal(report.verdict, "ok", `expected ok with full 200×50; got ${report.verdict} ${JSON.stringify(report.found)}`);
});

test("stampImageOnPdf: autoCrop:true embeds a smaller-dimensioned image (read /Width from PDF)", async () => {
  // 100×100 white PNG with a tiny 4×4 ink region. Auto-crop should shrink the
  // embedded image to roughly 6×6 (4 + 1px padding each side). Verify by
  // reading the embedded XObject's /Width and /Height directly.
  const w = 100, h = 100;
  const pixels = new Uint8Array(w * h * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; pixels[i + 3] = 255;
  }
  for (let y = 48; y < 52; y++) for (let x = 48; x < 52; x++) {
    const o = (y * w + x) * 4;
    pixels[o] = 0; pixels[o + 1] = 0; pixels[o + 2] = 0; pixels[o + 3] = 255;
  }
  const png = encodePng({ width: w, height: h, channels: 4, pixels });
  const pdf = await blankPdf();

  async function embeddedDims(pdfBytes: Buffer): Promise<{ width: number; height: number }> {
    const doc = await PDFDocument.load(pdfBytes);
    // Iterate all indirect objects and find the first one with /Subtype /Image
    // (the image XObject pdf-lib added when we called embedPng).
    const refs = doc.context.enumerateIndirectObjects();
    for (const [, obj] of refs) {
      // Stream objects have .dict; image XObjects have /Subtype = /Image
      const dict = (obj as { dict?: unknown }).dict;
      if (!dict) continue;
      const get = (dict as { get: (key: { toString: () => string } | string) => unknown }).get;
      if (typeof get !== "function") continue;
      const { PDFName } = await import("pdf-lib");
      const subtype = (dict as { get: (k: unknown) => unknown }).get(PDFName.of("Subtype"));
      if (subtype && String(subtype) === "/Image") {
        const widthObj = (dict as { get: (k: unknown) => unknown }).get(PDFName.of("Width"));
        const heightObj = (dict as { get: (k: unknown) => unknown }).get(PDFName.of("Height"));
        return {
          width: Number((widthObj as { numberValue?: number; value?: () => number })?.numberValue ?? (widthObj as { asNumber?: () => number })?.asNumber?.()),
          height: Number((heightObj as { numberValue?: number; value?: () => number })?.numberValue ?? (heightObj as { asNumber?: () => number })?.asNumber?.()),
        };
      }
    }
    return { width: -1, height: -1 };
  }

  const stampedWithCrop = await stampImageOnPdf(
    pdf,
    { kind: "buffer", data: png, mime: "image/png" },
    { page: 1, x: 100, y: 100, width: 100, height: 100 },
    { autoCrop: true },
  );
  const stampedNoCrop = await stampImageOnPdf(
    pdf,
    { kind: "buffer", data: png, mime: "image/png" },
    { page: 1, x: 100, y: 100, width: 100, height: 100 },
    { autoCrop: false },
  );
  const withDims = await embeddedDims(stampedWithCrop);
  const withoutDims = await embeddedDims(stampedNoCrop);
  assert.equal(withoutDims.width, 100, "no-crop embeds the full 100×100");
  assert.equal(withoutDims.height, 100);
  assert.ok(withDims.width < 20 && withDims.height < 20,
    `auto-crop should embed a small image; got ${withDims.width}×${withDims.height}`);
});

// ─── assessStampQuality warnings ──────────────────────────────────────────

test("assessStampQuality: STAMP_OFF_PAGE fires when the rect extends past the page", async () => {
  const pdf = await blankPdf(612, 792);
  const warnings = await assessStampQuality({
    pdfBytes: pdf, page: 1, x: 500, y: 100, width: 200, height: 50,
  });
  const off = warnings.find((w) => w.code === "STAMP_OFF_PAGE");
  assert.ok(off, "should flag off-page");
  assert.equal(off!.severity, "error");
});

test("assessStampQuality: STAMP_OUTSIZED_VS_TEXT fires when stamp is way taller than body text", async () => {
  const pdf = await busyPdf();
  // 200pt height on a page where median text height is 12pt → 16.7× ratio.
  const warnings = await assessStampQuality({
    pdfBytes: pdf, page: 1, x: 50, y: 50, width: 200, height: 200,
  });
  const out = warnings.find((w) => w.code === "STAMP_OUTSIZED_VS_TEXT");
  assert.ok(out, "should flag oversized stamp");
});

test("assessStampQuality: STAMP_OVERLAPS_TEXT fires when rect intersects text bboxes", async () => {
  const pdf = await busyPdf();
  // Page has body text at y=200..700. Place stamp at y=300 with height=200 → overlaps many lines.
  const warnings = await assessStampQuality({
    pdfBytes: pdf, page: 1, x: 100, y: 300, width: 400, height: 200,
  });
  const ov = warnings.find((w) => w.code === "STAMP_OVERLAPS_TEXT");
  assert.ok(ov, "should flag overlap");
  // Sample text should be included
  const details = ov!.details as { overlappingTextSamples: string[] };
  assert.ok(details.overlappingTextSamples.some((t) => /Body text line/.test(t)));
});

test("assessStampQuality: ASPECT_RATIO_DISTORTED fires when drawn aspect != natural by >5%", async () => {
  const pdf = await blankPdf();
  // Natural 10×100 (0.1), drawn 200×50 (4.0). Massive distortion.
  const warnings = await assessStampQuality({
    pdfBytes: pdf, page: 1, x: 100, y: 100, width: 200, height: 50,
    imageNaturalWidth: 10, imageNaturalHeight: 100,
  });
  const ar = warnings.find((w) => w.code === "ASPECT_RATIO_DISTORTED");
  assert.ok(ar, "should flag distorted aspect");
});

test("assessStampQuality: well-placed stamp on busy page produces no warnings", async () => {
  const pdf = await busyPdf();
  // y=100, height=50 — below the body text (which ends at y=200). No overlap.
  // Width 100, modest height. On-page. No natural dims passed.
  const warnings = await assessStampQuality({
    pdfBytes: pdf, page: 1, x: 100, y: 100, width: 100, height: 50,
  });
  assert.deepEqual(warnings, [], `expected no warnings, got: ${JSON.stringify(warnings)}`);
});
