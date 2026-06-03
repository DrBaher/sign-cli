import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectPdfSignatures, inspectPdfSignaturesBuffer } from "../lib/pdf-signature.js";
import { signPdfLocally } from "../lib/local-pdf-signer.js";
import { loadOrCreateSignerKeyPair } from "../lib/local-keys.js";

const UNSIGNED_PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF", "latin1");

function withScopedKeyDir<T>(fn: () => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pdf-sig-keys-"));
  const prev = process.env.SIGN_LOCAL_KEY_DIR;
  process.env.SIGN_LOCAL_KEY_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.SIGN_LOCAL_KEY_DIR;
    else process.env.SIGN_LOCAL_KEY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Locate the hex /Contents PKCS#7 blob offsets in a signed PDF buffer. */
function findContentsHexRegion(pdf: Buffer): { start: number; end: number } {
  const text = pdf.toString("latin1");
  const tag = "/Contents ";
  const tagIndex = text.indexOf(tag);
  const start = text.indexOf("<", tagIndex) + 1;
  const end = text.indexOf(">", start);
  return { start, end };
}

test("inspectPdfSignatures: a genuinely-signed PDF passes both digest and signature-value checks", async () => {
  await withScopedKeyDir(async () => {
    const signer = loadOrCreateSignerKeyPair({ email: "alice@example.com", name: "Alice" });
    const { signedPdf } = signPdfLocally(UNSIGNED_PDF, { signerKeyPair: signer });
    const report = await inspectPdfSignaturesBuffer(signedPdf, "genuine.pdf");
    assert.equal(report.signatureCount, 1);
    const sig = report.signatures[0];
    assert.equal(sig.contentDigestMatches, true, "content digest must match");
    assert.equal(sig.signatureValueVerified, true, "signature value must verify against the embedded cert");
    assert.equal(sig.messageDigestMatches, true, "overall verdict must be valid");
  });
});

test("inspectPdfSignatures: a forged PKCS#7 (matching digest, foreign cert, no private key) FAILS", async () => {
  await withScopedKeyDir(async () => {
    // Forge a signature that an attacker WITHOUT the victim's private key could
    // produce: take a genuine signature, then overwrite only the signature
    // OCTET STRING value with bytes the attacker controls (here, Mallory's
    // signature over the same SignedAttributes made with her OWN key). The
    // embedded cert and the messageDigest stay correct, but the signature
    // value no longer corresponds to the embedded cert's public key. The old
    // digest-only check passed this; cryptographic verification must reject it.
    const alice = loadOrCreateSignerKeyPair({ email: "alice@example.com", name: "Alice" });
    const { signedPdf } = signPdfLocally(UNSIGNED_PDF, { signerKeyPair: alice });

    const { start, end } = findContentsHexRegion(signedPdf);
    const blobHex = signedPdf.toString("latin1").slice(start, end).replace(/0+$/u, "");
    // Trim trailing padding to an even number of hex chars (whole bytes).
    const evenHex = blobHex.slice(0, blobHex.length - (blobHex.length % 2));
    const cms = Buffer.from(evenHex, "hex");

    // The genuine signature value is the 256-byte RSA signature over the
    // SignedAttrs (the trailing OCTET STRING of the SignerInfo, header
    // `04 82 01 00`). Flip every byte of it: still a 256-byte value (structure
    // and offsets preserved) but cryptographically wrong for Alice's key —
    // exactly what a no-private-key attacker is stuck with.
    const marker = Buffer.from([0x04, 0x82, 0x01, 0x00]);
    const sigHeaderIdx = cms.lastIndexOf(marker);
    assert.ok(sigHeaderIdx >= 0, "expected a 256-byte signature OCTET STRING in the CMS");
    const sigValueStart = sigHeaderIdx + marker.length;
    const forgedCms = Buffer.from(cms);
    for (let i = sigValueStart; i < sigValueStart + 256; i += 1) {
      forgedCms[i] = forgedCms[i] ^ 0xff;
    }

    // Re-embed the forged CMS, padded back to the original hex slot length.
    const slotLen = end - start;
    const forgedHex = forgedCms.toString("hex").padEnd(slotLen, "0");
    const forged = Buffer.from(signedPdf);
    forged.write(forgedHex, start, "latin1");

    const report = await inspectPdfSignaturesBuffer(forged, "forged.pdf");
    assert.equal(report.signatureCount, 1);
    const sig = report.signatures[0];
    // The content digest is untouched, so it still "matches" — proving the old
    // digest-only check would have passed this forgery.
    assert.equal(sig.contentDigestMatches, true, "digest is unchanged so it still matches");
    // ...but the signature value no longer verifies against Alice's key.
    assert.equal(sig.signatureValueVerified, false, "forged signature value must NOT verify");
    assert.equal(sig.messageDigestMatches, false, "overall verdict must be FAILURE for a forgery");
    assert.ok(
      sig.parseWarnings.some((w) => w.includes("did not verify")),
      "a warning must explain the signature-value verification failure",
    );
  });
});

test("inspectPdfSignatures: tampered signed region (digest mismatch) FAILS", async () => {
  await withScopedKeyDir(async () => {
    const signer = loadOrCreateSignerKeyPair({ email: "alice@example.com", name: "Alice" });
    const { signedPdf } = signPdfLocally(UNSIGNED_PDF, { signerKeyPair: signer });
    // Flip a byte in the signed region (the leading %PDF header) to break the
    // content digest.
    const tampered = Buffer.from(signedPdf);
    tampered[1] = tampered[1] ^ 0xff;
    const report = await inspectPdfSignaturesBuffer(tampered, "tampered.pdf");
    const sig = report.signatures[0];
    assert.equal(sig.contentDigestMatches, false, "tampered content must fail the digest check");
    assert.equal(sig.messageDigestMatches, false, "overall verdict must be FAILURE for tampered content");
  });
});

test("inspectPdfSignatures reports no signature on a plain PDF", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pdf-sig-"));
  const file = path.join(dir, "plain.pdf");
  writeFileSync(file, "%PDF-1.4\n% no signatures here\n%%EOF", "utf8");
  const report = await inspectPdfSignatures(file);
  assert.equal(report.hasSignature, false);
  assert.equal(report.signatureCount, 0);
  assert.ok(report.warnings.some((w) => w.includes("not signed")));
});

test("inspectPdfSignatures finds a /ByteRange and reports gracefully when /Contents is unparseable", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pdf-sig-"));
  const file = path.join(dir, "fake.pdf");
  // Construct a tiny PDF-like body with a /ByteRange but a fake Contents blob (not real PKCS#7)
  const before = Buffer.from("%PDF-1.4\n", "utf8");
  const placeholder = Buffer.from("/ByteRange [0 100 200 300] /Contents <DEADBEEF>", "utf8");
  const body = Buffer.concat([before, placeholder, Buffer.alloc(500, 0x20)]);
  writeFileSync(file, body);
  const report = await inspectPdfSignatures(file);
  assert.equal(report.signatureCount, 1);
  assert.deepEqual(report.signatures[0].byteRange, [0, 100, 200, 300]);
  // Either we parsed it (unlikely) or we recorded a warning about the parse — both acceptable.
  if (report.signatures[0].messageDigestMatches !== null) {
    // parsed something; OK
  } else {
    assert.ok(
      report.signatures[0].parseWarnings.length > 0
        || report.signatures[0].messageDigest === null,
      "expected a parse warning or null message digest for fake PKCS#7",
    );
  }
});
