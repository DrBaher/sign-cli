// Pure async helpers for embedding a raster image (PNG/JPG) onto a PDF page at
// a fixed rectangle. Used by the local provider at sign time so the signed PDF
// shows a visible signature image inside the bytes that PAdES then seals.
//
// SVG isn't supported yet — handled at a layer above by rasterizing to PNG
// before calling stampImageOnPdf (see follow-up work).

import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

export type ImageMime = "image/png" | "image/jpeg";

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

/**
 * Parse a CLI flag value into an ImageInput. Accepts:
 *   - "data:image/png;base64,..." or "data:image/jpeg;base64,..."
 *   - any other string, treated as a file path
 *
 * Raw base64 (no data: prefix) is intentionally rejected — the caller doesn't
 * know whether to treat it as PNG or JPG, and a typo of a file path would be
 * mis-decoded as base64 garbage. Force the user to be explicit with data:.
 */
export function parseImageInput(value: string): ImageInput {
  if (value.startsWith("data:")) {
    const match = /^data:(image\/(png|jpeg));base64,(.*)$/u.exec(value);
    if (!match) {
      throw new Error(
        `--signature-image data URL must be of the form "data:image/(png|jpeg);base64,<base64>"`,
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

function detectMimeFromBytes(bytes: Buffer): ImageMime {
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
  throw new Error(
    `signature image: unrecognized format (expected PNG or JPEG magic bytes). ` +
      `SVG is not supported yet; rasterize it to PNG first.`,
  );
}

function loadImageBytes(input: ImageInput): { bytes: Buffer; mime: ImageMime } {
  if (input.kind === "buffer") {
    return { bytes: input.data, mime: input.mime };
  }
  const bytes = readFileSync(input.path);
  return { bytes, mime: detectMimeFromBytes(bytes) };
}

/**
 * Draw `image` onto the given page+rectangle of `pdfBytes` and return the
 * modified PDF bytes. The PDF is rewritten in place (no incremental update),
 * which is intentional: the result is passed downstream to local-pdf-signer's
 * PAdES sealer, which needs a clean byte stream to compute /ByteRange over.
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
  const { bytes, mime } = loadImageBytes(image);
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
