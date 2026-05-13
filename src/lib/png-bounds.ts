// Minimal pure-JS PNG decoder + encoder, scoped to what we need for
// signature-image auto-crop:
//
//   1. Decode an 8-bit RGB or RGBA PNG into a row-major Uint8Array.
//   2. Find the bounding box of "ink" pixels (non-transparent AND not
//      near-white) so we can trim white margins.
//   3. Optionally replace near-white opaque pixels with transparent ones
//      (key-out), so a JPEG-on-white-background signature scan composes
//      cleanly over a PDF page.
//   4. Re-encode the (cropped, keyed-out) pixel buffer as a fresh PNG that
//      pdf-lib can embed.
//
// Supported subset:
//   - 8-bit depth (16-bit declines)
//   - color type 2 (RGB) and 6 (RGBA); palette / grayscale decline
//   - no interlacing (Adam7 declines)
//
// Anything outside that throws `UnsupportedPngError`. Callers should treat
// that as "skip auto-crop, stamp the original bytes as-is" — the worst case
// is just no cropping, never a corrupt PDF.
//
// References:
//   - PNG spec: https://www.w3.org/TR/PNG/
//   - Filter algorithms: https://www.w3.org/TR/PNG/#9Filters

import { deflateSync, inflateSync } from "node:zlib";

export class UnsupportedPngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPngError";
  }
}

export type PngInfo = {
  width: number;
  height: number;
  /** 3 = RGB, 4 = RGBA. */
  channels: 3 | 4;
  /** Row-major pixel data; length = width * height * channels. */
  pixels: Uint8Array;
};

export type CropBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

export function decodePng(bytes: Buffer): PngInfo {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new UnsupportedPngError("not a PNG (missing signature)");
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (pos + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(pos);
    const type = bytes.toString("ascii", pos + 4, pos + 8);
    const dataStart = pos + 8;
    const data = bytes.subarray(dataStart, dataStart + length);
    pos = dataStart + length + 4; // skip CRC

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      // data[10] compression, data[11] filter, data[12] interlace
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8) {
    throw new UnsupportedPngError(`bit depth ${bitDepth} not supported (only 8)`);
  }
  if (interlace !== 0) {
    throw new UnsupportedPngError("interlaced PNGs not supported");
  }
  let channels: 3 | 4;
  if (colorType === 2) channels = 3;
  else if (colorType === 6) channels = 4;
  else {
    throw new UnsupportedPngError(
      `color type ${colorType} not supported (only 2=RGB and 6=RGBA)`,
    );
  }

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const bpp = channels; // bytes-per-pixel (8-bit only)
  const scanlineLen = width * bpp;
  const pixels = new Uint8Array(width * height * bpp);
  let inflatedPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[inflatedPos++];
    const scanline = inflated.subarray(inflatedPos, inflatedPos + scanlineLen);
    inflatedPos += scanlineLen;
    const out = pixels.subarray(y * scanlineLen, (y + 1) * scanlineLen);
    const prev = y > 0
      ? pixels.subarray((y - 1) * scanlineLen, y * scanlineLen)
      : null;
    unfilterScanline(filter, scanline, out, prev, bpp);
  }
  return { width, height, channels, pixels };
}

function unfilterScanline(
  filter: number,
  scanline: Buffer,
  out: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
): void {
  for (let i = 0; i < scanline.length; i++) {
    const left = i >= bpp ? out[i - bpp] : 0;
    const up = prev ? prev[i] : 0;
    const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
    let recon: number;
    switch (filter) {
      case 0: recon = scanline[i]; break;
      case 1: recon = scanline[i] + left; break;
      case 2: recon = scanline[i] + up; break;
      case 3: recon = scanline[i] + ((left + up) >> 1); break;
      case 4: recon = scanline[i] + paethPredictor(left, up, upLeft); break;
      default: throw new UnsupportedPngError(`unknown filter type ${filter}`);
    }
    out[i] = recon & 0xff;
  }
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ---------------------------------------------------------------------------
// Bounds detection
// ---------------------------------------------------------------------------

/**
 * Find the tight bounding box of "ink" pixels. A pixel counts as ink when:
 *   - Its alpha is above `alphaThreshold` (RGBA only; opaque images skip
 *     this check), AND
 *   - Its R/G/B are not all above `whiteThreshold` (so cream / pastel
 *     pixels still count as ink).
 *
 * Returns the full image bounds if no ink is found (defensive — the caller
 * stamping logic just continues without cropping).
 */
export function inkBounds(
  png: PngInfo,
  opts: { whiteThreshold?: number; alphaThreshold?: number } = {},
): CropBounds {
  const whiteThreshold = opts.whiteThreshold ?? 240;
  const alphaThreshold = opts.alphaThreshold ?? 16;

  const { width, height, channels, pixels } = png;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      const a = channels === 4 ? pixels[offset + 3] : 255;
      if (a <= alphaThreshold) continue;
      if (r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    return { x: 0, y: 0, width, height };
  }
  // 1px padding around the ink, clamped to image.
  const pad = 1;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const right = Math.min(width - 1, maxX + pad);
  const bottom = Math.min(height - 1, maxY + pad);
  return { x, y, width: right - x + 1, height: bottom - y + 1 };
}

// ---------------------------------------------------------------------------
// Crop + key-out + re-encode
// ---------------------------------------------------------------------------

export type AutoCropOptions = {
  /** Replace near-white opaque pixels with transparent ones. Default: true. */
  keyOutWhite?: boolean;
  whiteThreshold?: number;
  alphaThreshold?: number;
};

/**
 * Decode the PNG, find the ink bounds, crop, and (if requested) replace
 * near-white opaque pixels with transparent ones. Returns a freshly-encoded
 * PNG buffer ready for `pdf-lib.embedPng()`. The output is always RGBA8 so
 * a stamping pipeline can rely on the alpha channel for compositing.
 *
 * Returns `null` (rather than throwing) if the input PNG uses an unsupported
 * subset — caller falls back to stamping the original bytes.
 */
export function autoCropPngBytes(bytes: Buffer, opts: AutoCropOptions = {}): Buffer | null {
  let png: PngInfo;
  try {
    png = decodePng(bytes);
  } catch (err) {
    if (err instanceof UnsupportedPngError) return null;
    throw err;
  }
  const bounds = inkBounds(png, opts);
  const cropped = cropPixels(png, bounds);
  const out = opts.keyOutWhite ?? true
    ? keyOutWhite(cropped, opts.whiteThreshold ?? 240)
    : cropped;
  return encodePng(out);
}

function cropPixels(png: PngInfo, bounds: CropBounds): PngInfo {
  const { width, height, channels, pixels } = png;
  if (
    bounds.x === 0 && bounds.y === 0 &&
    bounds.width === width && bounds.height === height
  ) {
    // No-op crop; ensure we still output RGBA so key-out can run.
    return channels === 4 ? png : promoteRgbToRgba(png);
  }
  const outChannels = 4; // always promote to RGBA
  const out = new Uint8Array(bounds.width * bounds.height * outChannels);
  for (let dy = 0; dy < bounds.height; dy++) {
    for (let dx = 0; dx < bounds.width; dx++) {
      const src = ((bounds.y + dy) * width + (bounds.x + dx)) * channels;
      const dst = (dy * bounds.width + dx) * outChannels;
      out[dst] = pixels[src];
      out[dst + 1] = pixels[src + 1];
      out[dst + 2] = pixels[src + 2];
      out[dst + 3] = channels === 4 ? pixels[src + 3] : 255;
    }
  }
  return { width: bounds.width, height: bounds.height, channels: 4, pixels: out };
}

function promoteRgbToRgba(png: PngInfo): PngInfo {
  const { width, height, pixels } = png;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
    out[j] = pixels[i];
    out[j + 1] = pixels[i + 1];
    out[j + 2] = pixels[i + 2];
    out[j + 3] = 255;
  }
  return { width, height, channels: 4, pixels: out };
}

function keyOutWhite(png: PngInfo, threshold: number): PngInfo {
  // png is RGBA8 at this point (cropPixels promotes).
  const { pixels } = png;
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    if (a > 0 && r >= threshold && g >= threshold && b >= threshold) {
      // Near-white opaque pixel → fully transparent.
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 0;
    } else {
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  }
  return { ...png, pixels: out };
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export function encodePng(info: PngInfo): Buffer {
  const { width, height, channels, pixels } = info;
  if (channels !== 3 && channels !== 4) {
    throw new Error(`encodePng: unsupported channels=${channels}`);
  }

  // IHDR (13 bytes)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // compression, filter, interlace

  // Filter pixels with type 0 (None) — simplest, slightly larger output but
  // good enough for cropped signature images. zlib's deflate compensates.
  const scanlineLen = width * channels;
  const filtered = Buffer.alloc(height * (scanlineLen + 1));
  for (let y = 0; y < height; y++) {
    filtered[y * (scanlineLen + 1)] = 0;
    Buffer.from(
      pixels.buffer,
      pixels.byteOffset + y * scanlineLen,
      scanlineLen,
    ).copy(filtered, y * (scanlineLen + 1) + 1);
  }
  const idat = deflateSync(filtered);

  return Buffer.concat([
    SIGNATURE,
    writeChunk("IHDR", ihdr),
    writeChunk("IDAT", idat),
    writeChunk("IEND", Buffer.alloc(0)),
  ]);
}

function writeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

// PNG uses CRC-32 (IEEE 802.3 polynomial 0xEDB88320, reversed). Build the
// table lazily; the loop runs once per process.
let crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}
