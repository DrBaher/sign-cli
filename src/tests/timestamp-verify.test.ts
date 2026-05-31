import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTimestampToken } from "../lib/timestamp-verify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX = path.resolve(__dirname, "../../fixtures/rfc3161");

const token = readFileSync(path.join(FX, "valid-token.tsr"));
const ca = readFileSync(path.join(FX, "test-ca.crt"));
const signerCert = readFileSync(path.join(FX, "tsa-signer.crt"));
const stampedData = readFileSync(path.join(FX, "stamped-data.bin"));
const expectedDigest = crypto.createHash("sha256").update(stampedData).digest();

test("accepts a valid RFC 3161 token over the expected digest", () => {
  const r = verifyTimestampToken(token, expectedDigest);
  assert.equal(r.verified, true, r.reasons.join("; "));
  assert.equal(r.digestMatches, true);
  assert.equal(r.hasTimeStampingEku, true);
  assert.equal(r.signatureValid, true);
  assert.equal(r.chainTrusted, null, "chain not checked without anchors");
  assert.match(r.genTime ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.match(r.signerSubject ?? "", /Sign CLI Test TSA/);
});

test("rejects a token whose messageImprint covers different data", () => {
  const wrong = crypto.createHash("sha256").update("not the stamped data").digest();
  const r = verifyTimestampToken(token, wrong);
  assert.equal(r.verified, false);
  assert.equal(r.digestMatches, false);
  assert.match(r.reasons[0], /does not match the expected digest/);
});

test("confirms the chain when the issuing CA is supplied as a trust anchor", () => {
  const r = verifyTimestampToken(token, expectedDigest, [ca]);
  assert.equal(r.verified, true, r.reasons.join("; "));
  assert.equal(r.chainTrusted, true);
});

test("rejects when the signer does not chain to the provided trust anchor", () => {
  // The signer's own leaf cert is not a CA for itself.
  const r = verifyTimestampToken(token, expectedDigest, [signerCert]);
  assert.equal(r.verified, false);
  assert.equal(r.chainTrusted, false);
  assert.match(r.reasons[0], /does not chain to any provided trust anchor/);
});

test("rejects a token with a tampered signature", () => {
  const tampered = Buffer.from(token);
  tampered[tampered.length - 10] ^= 0xff; // flip a byte inside the RSA signature
  const r = verifyTimestampToken(tampered, expectedDigest);
  assert.equal(r.verified, false);
  assert.match(r.reasons[0], /signature .* is invalid|parse failed/i);
});

test("rejects a token with tampered TSTInfo content (digest/signature break)", () => {
  // Flip a byte early in the structure (inside TSTInfo); either the imprint
  // no longer matches or the signed messageDigest breaks — both must fail.
  const tampered = Buffer.from(token);
  tampered[80] ^= 0xff;
  const r = verifyTimestampToken(tampered, expectedDigest);
  assert.equal(r.verified, false);
});

test("rejects a status-only / non-SignedData response", () => {
  // The shape the old mock TSA returned: SEQUENCE { INTEGER 0 } — granted
  // status but no token. This used to be treated as proof.
  const statusOnly = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]);
  const r = verifyTimestampToken(statusOnly, expectedDigest);
  assert.equal(r.verified, false);
  assert.match(r.reasons[0], /No SignedData|parse failed/i);
});

test("rejects an empty buffer without throwing", () => {
  const r = verifyTimestampToken(Buffer.alloc(0), expectedDigest);
  assert.equal(r.verified, false);
  assert.ok(r.reasons.length > 0);
});
