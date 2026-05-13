import test from "node:test";
import assert from "node:assert/strict";
import {
  decodePng,
  encodePng,
  inkBounds,
  autoCropPngBytes,
  UnsupportedPngError,
  type PngInfo,
} from "../lib/png-bounds.js";

function rgbaSolid(width: number, height: number, r: number, g: number, b: number, a: number): PngInfo {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
  }
  return { width, height, channels: 4, pixels };
}

function setPixel(png: PngInfo, x: number, y: number, r: number, g: number, b: number, a: number): void {
  const i = (y * png.width + x) * png.channels;
  png.pixels[i] = r;
  png.pixels[i + 1] = g;
  png.pixels[i + 2] = b;
  if (png.channels === 4) png.pixels[i + 3] = a;
}

test("encodePng → decodePng roundtrip preserves pixel data (RGBA)", () => {
  const input = rgbaSolid(8, 6, 255, 0, 0, 255);
  setPixel(input, 2, 3, 0, 128, 64, 200);
  const bytes = encodePng(input);
  const out = decodePng(bytes);
  assert.equal(out.width, 8);
  assert.equal(out.height, 6);
  assert.equal(out.channels, 4);
  assert.deepEqual(Array.from(out.pixels), Array.from(input.pixels));
});

test("encodePng → decodePng roundtrip preserves pixel data (RGB)", () => {
  const w = 4, h = 4;
  const pixels = new Uint8Array(w * h * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = i % 256; pixels[i + 1] = (i * 3) % 256; pixels[i + 2] = (i * 7) % 256;
  }
  const input: PngInfo = { width: w, height: h, channels: 3, pixels };
  const bytes = encodePng(input);
  const out = decodePng(bytes);
  assert.equal(out.channels, 3);
  assert.deepEqual(Array.from(out.pixels), Array.from(input.pixels));
});

test("inkBounds: white image returns full bounds (no ink found)", () => {
  const png = rgbaSolid(10, 10, 255, 255, 255, 255);
  const b = inkBounds(png);
  assert.deepEqual(b, { x: 0, y: 0, width: 10, height: 10 });
});

test("inkBounds: ink in a 4×3 region inside a 20×20 white image → tight bbox + 1px padding", () => {
  const png = rgbaSolid(20, 20, 255, 255, 255, 255);
  for (let y = 5; y < 8; y++) for (let x = 8; x < 12; x++) {
    setPixel(png, x, y, 0, 0, 0, 255);
  }
  const b = inkBounds(png);
  // 1px padding around ink (8..11, 5..7) → (7..12, 4..8) = 6×5
  assert.deepEqual(b, { x: 7, y: 4, width: 6, height: 5 });
});

test("inkBounds: transparent pixels are not ink, regardless of color", () => {
  const png = rgbaSolid(10, 10, 0, 0, 0, 0); // fully transparent black
  const b = inkBounds(png);
  assert.deepEqual(b, { x: 0, y: 0, width: 10, height: 10 });
});

test("autoCropPngBytes: 100×100 with 20×10 ink → ~22×12 cropped output (1px pad)", () => {
  const png = rgbaSolid(100, 100, 255, 255, 255, 255);
  for (let y = 45; y < 55; y++) for (let x = 40; x < 60; x++) {
    setPixel(png, x, y, 0, 0, 0, 255);
  }
  const cropped = autoCropPngBytes(encodePng(png));
  assert.ok(cropped, "autoCrop should succeed");
  const out = decodePng(cropped!);
  assert.equal(out.width, 22);
  assert.equal(out.height, 12);
});

test("autoCropPngBytes: key-out makes near-white opaque pixels transparent", () => {
  const png = rgbaSolid(20, 20, 255, 255, 255, 255);
  setPixel(png, 10, 10, 0, 0, 0, 255); // black ink
  const cropped = autoCropPngBytes(encodePng(png));
  assert.ok(cropped);
  const out = decodePng(cropped!);
  // After crop+key-out: the black ink is opaque, the white padding is transparent
  // Find a corner pixel (should be transparent)
  const cornerAlpha = out.pixels[3]; // first pixel's alpha
  assert.equal(cornerAlpha, 0, "corner padding should be transparent after key-out");
  // The ink pixel should still be black + opaque. Find it:
  let found = false;
  for (let i = 0; i < out.pixels.length; i += 4) {
    if (out.pixels[i] === 0 && out.pixels[i + 1] === 0 && out.pixels[i + 2] === 0 && out.pixels[i + 3] === 255) {
      found = true; break;
    }
  }
  assert.ok(found, "ink pixel should survive key-out");
});

test("autoCropPngBytes: opt-out of key-out preserves opaque white", () => {
  const png = rgbaSolid(20, 20, 255, 255, 255, 255);
  setPixel(png, 10, 10, 0, 0, 0, 255);
  const cropped = autoCropPngBytes(encodePng(png), { keyOutWhite: false });
  assert.ok(cropped);
  const out = decodePng(cropped!);
  const cornerAlpha = out.pixels[3];
  assert.equal(cornerAlpha, 255, "padding stays opaque when keyOutWhite is false");
});

test("autoCropPngBytes: returns null on non-PNG bytes (graceful fallback)", () => {
  const result = autoCropPngBytes(Buffer.from("not a PNG"));
  assert.equal(result, null);
});

test("decodePng: throws UnsupportedPngError on a bad signature", () => {
  assert.throws(() => decodePng(Buffer.from("definitely not a PNG")), UnsupportedPngError);
});
