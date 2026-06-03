import test from "node:test";
import assert from "node:assert/strict";
import {
  computeVerifySummary,
  verifyVerdictExitCode,
  type VerifyVerdict,
} from "../lib/signing-service.js";
import type { PdfSignatureReport, PdfSignatureFinding } from "../lib/pdf-signature.js";
import type { SignerInput } from "../lib/util.js";

const signer = (email: string, order = 1): SignerInput => ({ name: email, email, order });

const finding = (overrides: Partial<PdfSignatureFinding> = {}): PdfSignatureFinding => ({
  byteRange: [0, 100, 200, 100],
  byteRangeDigest: "deadbeef",
  messageDigestMatches: true,
  contentDigestMatches: true,
  signatureValueVerified: true,
  messageDigest: "abcd",
  digestAlgorithm: "sha256",
  signatureAlgorithm: "rsa-sha256",
  signers: [{ subject: "CN=alice@example.com,O=Sign CLI", issuer: null, validFrom: null, validTo: null, serialNumber: null, fingerprintSha256: null, trust: "unknown" }],
  rawSignatureBytes: 1024,
  parseWarnings: [],
  ...overrides,
});

const report = (signatures: PdfSignatureFinding[], warnings: string[] = []): PdfSignatureReport => ({
  path: "/tmp/x.pdf",
  fileSize: 1000,
  signatures,
  signatureCount: signatures.length,
  hasSignature: signatures.length > 0,
  warnings,
});

test("verifyVerdictExitCode: each verdict maps to its documented exit code", () => {
  const map: Array<[VerifyVerdict, 0 | 2 | 3 | 4 | 5]> = [
    ["ok", 0],
    ["warnings", 2],
    ["digest_mismatch", 3],
    ["no_signature", 4],
    ["signer_mismatch", 5],
  ];
  for (const [v, code] of map) {
    assert.equal(verifyVerdictExitCode(v), code, `verdict=${v} expected ${code}`);
  }
});

test("computeVerifySummary: clean signed PDF → verdict=ok, exit=0", () => {
  const summary = computeVerifySummary(report([finding()]), [signer("alice@example.com")]);
  assert.deepEqual(summary, {
    signature_present: true,
    digest_ok: true,
    signer_match: true,
    warnings_count: 0,
    trust: "unknown",
    verdict: "ok",
  });
});

test("computeVerifySummary: no signatures → verdict=no_signature (exit 4)", () => {
  const summary = computeVerifySummary(report([]), [signer("alice@example.com")]);
  assert.equal(summary.signature_present, false);
  assert.equal(summary.verdict, "no_signature");
  assert.equal(verifyVerdictExitCode(summary.verdict), 4);
});

test("computeVerifySummary: digest mismatch beats every other failure mode", () => {
  // Even if signer also doesn't match AND there are warnings, digest_mismatch
  // is the most severe (tamper), so that's what we report.
  const summary = computeVerifySummary(
    report([finding({ messageDigestMatches: false, parseWarnings: ["odd"] })], ["top-level warning"]),
    [signer("nobody@example.com")],
  );
  assert.equal(summary.digest_ok, false);
  assert.equal(summary.verdict, "digest_mismatch");
});

test("computeVerifySummary: signer_mismatch when persisted signer is missing from PDF", () => {
  // Digest_ok is true; PDF was signed by alice, but we expected bob.
  const summary = computeVerifySummary(
    report([finding()]),
    [signer("bob@example.com")],
  );
  assert.equal(summary.digest_ok, true);
  assert.equal(summary.signer_match, false);
  assert.equal(summary.verdict, "signer_mismatch");
});

test("computeVerifySummary: extra PDF signers are tolerated (Persisted ⊆ PDF)", () => {
  // PDF signed by alice + bob; we only expected alice. Per the chosen
  // semantic, that's fine — no missing signer is the rule.
  const summary = computeVerifySummary(
    report([
      finding(),
      finding({ signers: [{ subject: "CN=bob@example.com", issuer: null, validFrom: null, validTo: null, serialNumber: null, fingerprintSha256: null, trust: "unknown" }] }),
    ]),
    [signer("alice@example.com")],
  );
  assert.equal(summary.signer_match, true);
  assert.equal(summary.verdict, "ok");
});

test("computeVerifySummary: warnings-only → verdict=warnings (exit 2)", () => {
  const summary = computeVerifySummary(
    report([finding({ parseWarnings: ["truncated optional field"] })]),
    [signer("alice@example.com")],
  );
  assert.equal(summary.digest_ok, true);
  assert.equal(summary.signer_match, true);
  assert.equal(summary.warnings_count, 1);
  assert.equal(summary.verdict, "warnings");
  assert.equal(verifyVerdictExitCode(summary.verdict), 2);
});

test("computeVerifySummary: top-level + per-signature warnings both counted", () => {
  const summary = computeVerifySummary(
    report(
      [finding({ parseWarnings: ["a", "b"] }), finding({ parseWarnings: ["c"] })],
      ["top1", "top2"],
    ),
    [signer("alice@example.com")],
  );
  assert.equal(summary.warnings_count, 5);
});

test("computeVerifySummary: zero persisted signers → signer_match vacuously true", () => {
  // Path-only verify (no DB request) means we skip signer_match by passing
  // an empty signer list. The PDF still has to pass digest checks.
  const summary = computeVerifySummary(report([finding()]), []);
  assert.equal(summary.signer_match, true);
  assert.equal(summary.verdict, "ok");
});

test("computeVerifySummary: email match is case-insensitive", () => {
  const summary = computeVerifySummary(
    report([finding({ signers: [{ subject: "CN=ALICE@EXAMPLE.COM", issuer: null, validFrom: null, validTo: null, serialNumber: null, fingerprintSha256: null, trust: "unknown" }] })]),
    [signer("alice@example.com")],
  );
  assert.equal(summary.signer_match, true);
});

test("computeVerifySummary: matcher strips RFC 4514 backslash escapes in the cert subject", () => {
  // Node's X509Certificate.subject returns the LDAP-format DN string where
  // reserved chars like `+`, `<`, `>` are backslash-escaped. A real per-
  // signer cert subject is e.g. `CN=Baher Test \<baher\+dcc@example.com\>`.
  // A raw `subject.includes("baher+dcc@example.com")` would FALSELY return
  // signer_mismatch on a perfectly valid signature. Regression test for the
  // GBrain DCC NDA smoke test (2026-05-14).
  const summary = computeVerifySummary(
    report([finding({ signers: [{
      subject: "CN=Baher Test \\<baher\\+dcc@example.com\\>\nO=Sign CLI Local Provider",
      issuer: null, validFrom: null, validTo: null, serialNumber: null,
      fingerprintSha256: null, trust: "self_signed_local",
    }] })]),
    [signer("baher+dcc@example.com")],
  );
  assert.equal(summary.signer_match, true, "signer_match must hold against an RFC 4514-escaped subject");
  assert.equal(summary.verdict, "ok");
});

test("computeVerifySummary: no_signature precedence — even with warnings, no_signature wins", () => {
  const summary = computeVerifySummary(report([], ["top-level warn"]), [signer("alice@example.com")]);
  assert.equal(summary.verdict, "no_signature");
});
