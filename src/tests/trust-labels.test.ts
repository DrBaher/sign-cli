import test from "node:test";
import assert from "node:assert/strict";
import { computeVerifySummary } from "../lib/signing-service.js";
import type { PdfSignatureReport, PdfSignatureFinding, TrustLabel } from "../lib/pdf-signature.js";

const fingerprint = "f1ng3rpr1nt";

const cert = (trust: TrustLabel, opts: Partial<{ subject: string; issuer: string }> = {}) => ({
  subject: opts.subject ?? "CN=alice@example.com",
  issuer: opts.issuer ?? "CN=alice@example.com",
  validFrom: null,
  validTo: null,
  serialNumber: null,
  fingerprintSha256: fingerprint,
  trust,
});

const finding = (signers: ReturnType<typeof cert>[]): PdfSignatureFinding => ({
  byteRange: [0, 100, 200, 100],
  byteRangeDigest: "x",
  messageDigestMatches: true,
  messageDigest: "y",
  digestAlgorithm: "sha256",
  signatureAlgorithm: "rsa-sha256",
  signers,
  rawSignatureBytes: 1024,
  parseWarnings: [],
});

const report = (signatures: PdfSignatureFinding[]): PdfSignatureReport => ({
  path: "/tmp/x.pdf",
  fileSize: 1000,
  signatures,
  signatureCount: signatures.length,
  hasSignature: signatures.length > 0,
  warnings: [],
});

test("worst_trust: ca_signed when every signer is CA-signed", () => {
  const s = computeVerifySummary(report([finding([cert("ca_signed")])]), []);
  assert.equal(s.trust, "ca_signed");
});

test("worst_trust: self_signed_local when the only signer is local self-signed", () => {
  const s = computeVerifySummary(report([finding([cert("self_signed_local")])]), []);
  assert.equal(s.trust, "self_signed_local");
});

test("worst_trust: drops to self_signed_local when CA + local both present", () => {
  const s = computeVerifySummary(
    report([finding([cert("ca_signed")]), finding([cert("self_signed_local")])]),
    [],
  );
  assert.equal(s.trust, "self_signed_local");
});

test("worst_trust: drops to self_signed_other when a foreign self-signed cert is present", () => {
  const s = computeVerifySummary(
    report([finding([cert("ca_signed"), cert("self_signed_other")])]),
    [],
  );
  assert.equal(s.trust, "self_signed_other");
});

test("worst_trust: drops to unknown when any signer is unparsed", () => {
  const s = computeVerifySummary(
    report([finding([cert("ca_signed"), cert("unknown")])]),
    [],
  );
  assert.equal(s.trust, "unknown");
});

test("worst_trust: unsigned file reports 'unknown' (not the default 'ca_signed') as a defensive choice", () => {
  // Verdict will be no_signature, but trust must NOT pretend the file is
  // CA-signed — that would let a downstream "trust good?" gate accidentally
  // accept an unsigned PDF.
  const s = computeVerifySummary(report([]), []);
  assert.equal(s.verdict, "no_signature");
  assert.equal(s.trust, "unknown");
});

test("worst_trust: multiple signatures, mixed trust — picks the worst across all of them", () => {
  const s = computeVerifySummary(
    report([
      finding([cert("ca_signed")]),
      finding([cert("self_signed_local")]),
      finding([cert("self_signed_other")]),
    ]),
    [],
  );
  // Worst rank: self_signed_other (1) < self_signed_local (2) < ca_signed (3)
  assert.equal(s.trust, "self_signed_other");
});
