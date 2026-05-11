// Pure async helpers for embedding a raster image (PNG/JPG) — or a vector SVG
// rasterized at stamp-time — onto a PDF page at a fixed rectangle. Used by
// the local provider at sign time so the signed PDF shows a visible signature
// inside the bytes that PAdES then seals.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

export type ImageMime = "image/png" | "image/jpeg" | "image/svg+xml";

export type StampPosition = {
  /** 1-indexed page number. */
  page: number;
  /** PDF points from the page's left edge. */
  x: number;
  /** PDF points from the page's bottom edge (PDF origin is bottom-left). */
  y: number;
  /** Width of the drawn image in PDF points. */
  width: number;
  /** Height of the drawn image in PDF points. */
  height: number;
};

export type ImageInput =
  | { kind: "file"; path: string }
  | { kind: "buffer"; data: Buffer; mime: ImageMime };

/** Map a recognised image mime to the file extension we persist on disk. */
export function mimeToExt(mime: ImageMime): "png" | "jpg" | "svg" {
  switch (mime) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/svg+xml": return "svg";
  }
}

/**
 * Parse a CLI flag value into an ImageInput. Accepts:
 *   - "data:image/(png|jpeg|svg+xml);base64,..."
 *   - any other string, treated as a file path
 *
 * Raw base64 (no data: prefix) is intentionally rejected — the caller doesn't
 * know whether to treat it as PNG/JPG/SVG, and a typo of a file path would be
 * mis-decoded as base64 garbage. Force the user to be explicit with data:.
 */
export function parseImageInput(value: string): ImageInput {
  if (value.startsWith("data:")) {
    const match = /^data:(image\/(png|jpeg|svg\+xml));base64,(.*)$/u.exec(value);
    if (!match) {
      throw new Error(
        `--signature-image data URL must be of the form ` +
          `"data:image/(png|jpeg|svg+xml);base64,<base64>"`,
      );
    }
    const mime = match[1] as ImageMime;
    const data = Buffer.from(match[3], "base64");
    if (data.length === 0) {
      throw new Error(`--signature-image data URL decoded to zero bytes`);
    }
    return { kind: "buffer", data, mime };
  }
  return { kind: "file", path: value };
}

/**
 * Detect the image format from the leading bytes. Exported so the local
 * provider can pick the right on-disk extension when persisting a file
 * input whose path doesn't make the mime obvious (e.g. signature.bin).
 */
export function detectMimeFromBytes(bytes: Buffer): ImageMime {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  // JPG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  // SVG: starts with "<?xml" or "<svg" (after optional BOM / whitespace).
  const headSize = Math.min(bytes.length, 1024);
  const head = bytes.subarray(0, headSize).toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) {
    return "image/svg+xml";
  }
  throw new Error(
    `signature image: unrecognized format (expected PNG, JPEG, or SVG bytes).`,
  );
}

// ─── resvg-wasm init: load the WASM blob lazily once per process. ───────────
// initWasm is a one-shot — calling it twice throws. We cache the promise so
// concurrent stamps don't race, and we resolve the wasm path via createRequire
// because ESM doesn't expose __dirname.

let resvgInit: Promise<void> | null = null;

function ensureResvgInit(): Promise<void> {
  if (!resvgInit) {
    resvgInit = (async () => {
      const req = createRequire(import.meta.url);
      const wasmPath = req.resolve("@resvg/resvg-wasm/index_bg.wasm");
      const wasmBytes = readFileSync(wasmPath);
      await initWasm(wasmBytes);
    })();
  }
  return resvgInit;
}

/**
 * Rasterize SVG bytes to PNG at a width chosen to look crisp when drawn at
 * `targetPointWidth` PDF points (1pt = 1/72 inch). 300 DPI is the sweet spot
 * for signatures — print-quality, still small enough to keep the PDF lean.
 */
async function rasterizeSvgToPng(
  svgBytes: Buffer,
  targetPointWidth: number,
): Promise<Buffer> {
  await ensureResvgInit();
  const dpi = 300;
  const widthPx = Math.min(2000, Math.max(64, Math.round((targetPointWidth * dpi) / 72)));
  const resvg = new Resvg(new Uint8Array(svgBytes), {
    fitTo: { mode: "width", value: widthPx },
    background: "rgba(0,0,0,0)",
  });
  const rendered = resvg.render();
  const png = Buffer.from(rendered.asPng());
  rendered.free();
  resvg.free();
  return png;
}

/**
 * Load the image bytes + resolve mime. SVG inputs are rasterized to PNG at a
 * resolution suited to the eventual stamp rectangle (caller passes
 * `targetPointWidth`). Returns a normalized PNG/JPEG pair for pdf-lib.
 */
async function loadImageBytes(
  input: ImageInput,
  targetPointWidth: number,
): Promise<{ bytes: Buffer; mime: "image/png" | "image/jpeg" }> {
  let bytes: Buffer;
  let mime: ImageMime;
  if (input.kind === "buffer") {
    bytes = input.data;
    mime = input.mime;
  } else {
    bytes = readFileSync(input.path);
    mime = detectMimeFromBytes(bytes);
  }
  if (mime === "image/svg+xml") {
    bytes = await rasterizeSvgToPng(bytes, targetPointWidth);
    return { bytes, mime: "image/png" };
  }
  return { bytes, mime };
}

/**
 * Draw `image` onto the given page+rectangle of `pdfBytes` and return the
 * modified PDF bytes. The PDF is rewritten in place (no incremental update),
 * which is intentional: the result is passed downstream to local-pdf-signer's
 * PAdES sealer, which needs a clean byte stream to compute /ByteRange over.
 *
 * SVG inputs are rasterized at ~300 DPI of the target rectangle before being
 * embedded; PNG/JPG pass through unchanged.
 *
 * Throws on missing page, unsupported image format, or zero-byte image.
 */
export async function stampImageOnPdf(
  pdfBytes: Buffer,
  image: ImageInput,
  position: StampPosition,
): Promise<Buffer> {
  if (position.page < 1) {
    throw new Error(`stampImageOnPdf: page is 1-indexed; got ${position.page}`);
  }
  if (position.width <= 0 || position.height <= 0) {
    throw new Error(
      `stampImageOnPdf: width and height must be > 0 (got ${position.width} x ${position.height})`,
    );
  }
  const { bytes, mime } = await loadImageBytes(image, position.width);
  if (bytes.length === 0) {
    throw new Error(`stampImageOnPdf: image is empty`);
  }

  const pdf = await PDFDocument.load(pdfBytes);
  const pages = pdf.getPages();
  if (position.page > pages.length) {
    throw new Error(
      `stampImageOnPdf: page ${position.page} is out of range (PDF has ${pages.length})`,
    );
  }
  const page = pages[position.page - 1];

  const embedded =
    mime === "image/png"
      ? await pdf.embedPng(bytes)
      : await pdf.embedJpg(bytes);

  page.drawImage(embedded, {
    x: position.x,
    y: position.y,
    width: position.width,
    height: position.height,
  });

  const saved = await pdf.save({ useObjectStreams: false });
  return Buffer.from(saved);
}
