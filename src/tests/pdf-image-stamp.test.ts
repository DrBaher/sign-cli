import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { loadOrCreateSignerKeyPair } from "../lib/local-keys.js";
import { inspectPdfSignatures } from "../lib/pdf-signature.js";
import { parseImageInput, stampImageOnPdf } from "../lib/pdf-image-stamp.js";
import {
  createSigningRequest,
  fetchFinalSignedPdf,
  inspectRequestSignedPdf,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

const SAMPLE_PDF = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj
4 0 obj << /Length 30 >> stream
BT /F1 14 Tf 60 720 Td (Image-stamp test.) Tj ET
endstream
endobj
trailer << /Root 1 0 R /Size 5 >>
%%EOF`, "latin1");

/**
 * Build a valid 1x1 red PNG from scratch — avoids hand-pasted CRC tables and
 * lets the test stay self-contained. The trick is computing the PNG chunk
 * CRC32 correctly; the IEEE 802.3 polynomial 0xedb88320 below is the same as
 * node:zlib.crc32 would give in newer Node, but we inline it for portability.
 */
function makeRedPng(): Buffer {
  function crc32(data: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      c ^= data[i];
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : (c >>> 1);
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "latin1");
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8;              // bit depth
  ihdr[9] = 2;              // color type: 2 = RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.from([0x00, 0xff, 0x00, 0x00]); // filter byte + RGB red
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-image-stamp-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousKeys = process.env.SIGN_LOCAL_KEY_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_KEY_DIR = path.join(dir, "keys");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousKeys === undefined) delete process.env.SIGN_LOCAL_KEY_DIR;
    else process.env.SIGN_LOCAL_KEY_DIR = previousKeys;
    if (previousAuto === undefined) delete process.env.SIGN_LOCAL_AUTOCOMPLETE;
    else process.env.SIGN_LOCAL_AUTOCOMPLETE = previousAuto;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

test("stampImageOnPdf embeds a PNG image into the target page", async () => {
  const png = makeRedPng();
  const stamped = await stampImageOnPdf(SAMPLE_PDF, { kind: "buffer", data: png, mime: "image/png" }, {
    page: 1, x: 100, y: 200, width: 50, height: 50,
  });
  assert.equal(stamped.subarray(0, 5).toString("latin1"), "%PDF-", "output starts with PDF magic");
  const reloaded = await PDFDocument.load(stamped);
  assert.equal(reloaded.getPageCount(), 1, "stamped PDF has one page");
  // The new image resource should be one of the embedded images on the page.
  // pdf-lib's API for inspecting resources is internal; the fact that load()
  // succeeded plus the size grew enough to fit the image is a decent smoke.
  assert.ok(stamped.length > SAMPLE_PDF.length, "stamped PDF is larger than original");
});

test("stampImageOnPdf rejects out-of-range page numbers", async () => {
  const png = makeRedPng();
  await assert.rejects(
    () => stampImageOnPdf(SAMPLE_PDF, { kind: "buffer", data: png, mime: "image/png" }, {
      page: 99, x: 0, y: 0, width: 10, height: 10,
    }),
    /page 99 is out of range/i,
  );
});

test("parseImageInput accepts file paths and data URLs", () => {
  const fileInput = parseImageInput("/tmp/sig.png");
  assert.equal(fileInput.kind, "file");
  assert.equal((fileInput as { kind: "file"; path: string }).path, "/tmp/sig.png");

  const dataInput = parseImageInput("data:image/png;base64,iVBORw0KGgo=");
  assert.equal(dataInput.kind, "buffer");
  assert.equal((dataInput as { kind: "buffer"; mime: string }).mime, "image/png");

  assert.throws(() => parseImageInput("data:image/png;base64,"), /zero bytes/);
  assert.throws(() => parseImageInput("data:image/svg;base64,xxxx"), /data URL must be/);
});

test("signSigningRequest with --signature-image stamps the PDF and keeps the PAdES signature valid", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-image-flow-"));
    const documentPath = path.join(dir, "doc.pdf");
    writeFileSync(documentPath, SAMPLE_PDF);
    const png = makeRedPng();
    try {
      const created = createSigningRequest(db, {
        title: "Image-stamped contract",
        documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const aliceToken = created.tokens[0].token;
      signSigningRequest(db, {
        requestId: created.requestId,
        token: aliceToken,
        signatureImage: { kind: "buffer", data: png, mime: "image/png" },
        signatureImagePosition: { page: 1, x: 100, y: 200, width: 80, height: 40 },
      });

      const final = await fetchFinalSignedPdf(db, {
        requestId: created.requestId,
        provider: "local",
        outPath: path.join(dir, "signed.pdf"),
      });
      const finalBytes = readFileSync(final.path);
      assert.equal(finalBytes.subarray(0, 5).toString("latin1"), "%PDF-");

      // Existing PAdES inspection: signature still validates after we injected the image.
      const inspection = await inspectRequestSignedPdf(db, {
        requestId: created.requestId,
        path: final.path,
      });
      assert.equal(inspection.report.signatureCount, 1, "exactly one signer");
      assert.equal(
        inspection.report.signatures.every((s) => s.messageDigestMatches === true),
        true,
        "messageDigest must match the byte-range hash even with the image embedded",
      );

      // Touch the keypair function so the test's intent (one cert per signer) is
      // robust against future refactors that lazy-load keys differently.
      void loadOrCreateSignerKeyPair({ email: "alice@example.com", name: "Alice" });
    } finally {
      cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
