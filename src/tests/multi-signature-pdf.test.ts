import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrCreateSignerKeyPair } from "../lib/local-keys.js";
import { signPdfLocally, signPdfLocallyMultiSigner } from "../lib/local-pdf-signer.js";
import { inspectPdfSignatures } from "../lib/pdf-signature.js";
import {
  createSigningRequest,
  fetchFinalSignedPdf,
  inspectRequestSignedPdf,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-multi-pades-"));
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

const SAMPLE_PDF = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj
4 0 obj << /Length 30 >> stream
BT /F1 14 Tf 60 720 Td (Multi-sig PDF test.) Tj ET
endstream
endobj
trailer << /Root 1 0 R /Size 5 >>
%%EOF`, "latin1");

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, SAMPLE_PDF);
  return documentPath;
}

test("signPdfLocallyMultiSigner produces a PDF with one PKCS#7 dict per signer", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const alice = loadOrCreateSignerKeyPair({ email: "alice@example.com", name: "Alice" });
    const bob = loadOrCreateSignerKeyPair({ email: "bob@example.com", name: "Bob" });
    const result = signPdfLocallyMultiSigner(SAMPLE_PDF, [
      { keyPair: alice, signerLabel: "alice@example.com" },
      { keyPair: bob, signerLabel: "bob@example.com" },
    ]);
    const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-multi-pades-out-"));
    const outPath = path.join(tmp, "out.pdf");
    writeFileSync(outPath, result.signedPdf);
    try {
      const report = await inspectPdfSignatures(outPath);
      assert.equal(report.hasSignature, true);
      assert.equal(report.signatureCount, 2, `expected 2 signatures, got ${report.signatureCount}`);
      assert.equal(result.signers.length, 2);
      assert.notEqual(result.signers[0].signerFingerprintSha256, result.signers[1].signerFingerprintSha256);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test("signPdfLocally (single-sig) preserves backward-compatible 1-signature output", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const result = signPdfLocally(SAMPLE_PDF);
    const tmp = mkdtempSync(path.join(os.tmpdir(), "sign-single-pades-out-"));
    const outPath = path.join(tmp, "out.pdf");
    writeFileSync(outPath, result.signedPdf);
    try {
      const report = await inspectPdfSignatures(outPath);
      assert.equal(report.signatureCount, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test("two-signer local request writes a final PDF with two embedded signatures, each by its own cert", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-multi-pades-flow-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Multi-sig flow",
        documentPath,
        signers: [
          { name: "Alice", email: "alice@example.com", order: 1 },
          { name: "Bob", email: "bob@example.com", order: 2 },
        ],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const aliceToken = created.tokens.find((t) => t.signer.email === "alice@example.com")!.token;
      const bobToken = created.tokens.find((t) => t.signer.email === "bob@example.com")!.token;
      signSigningRequest(db, { requestId: created.requestId, token: aliceToken });
      signSigningRequest(db, { requestId: created.requestId, token: bobToken });

      const final = await fetchFinalSignedPdf(db, {
        requestId: created.requestId,
        provider: "local",
        outPath: path.join(dir, "signed.pdf"),
      });
      const inspection = await inspectRequestSignedPdf(db, {
        requestId: created.requestId,
        path: final.path,
      });
      assert.equal(inspection.report.signatureCount, 2, "final PDF must carry one signature per signer");
      assert.equal(
        inspection.report.signatures.every((s) => s.messageDigestMatches === true),
        true,
        "every signature's messageDigest must match the recomputed byte-range hash",
      );

      // Cert subjects should mention each signer's email.
      const subjectsBlob = inspection.report.signatures
        .flatMap((s) => s.signers.map((cert) => cert.subject ?? ""))
        .join(" | ");
      assert.match(subjectsBlob, /alice@example\.com/);
      assert.match(subjectsBlob, /bob@example\.com/);

      // Sanity: each signature carries a 16 KB placeholder, so the final PDF
      // is at least ~30 KB once both signatures landed.
      const bytes = readFileSync(final.path);
      assert.ok(bytes.length > 32_000, `final PDF should include both signature blobs; got ${bytes.length} bytes`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
