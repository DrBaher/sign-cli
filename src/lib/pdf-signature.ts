import { readFile } from "node:fs/promises";
import crypto, { X509Certificate } from "node:crypto";
import { parseAsn1, decodeOid } from "./asn1.js";
import type { Asn1Node } from "./asn1.js";

export type PdfSignatureFinding = {
  byteRange: [number, number, number, number];
  byteRangeDigest: string;
  messageDigestMatches: boolean | null;
  messageDigest: string | null;
  digestAlgorithm: string | null;
  signatureAlgorithm: string | null;
  signers: Array<{
    subject: string | null;
    issuer: string | null;
    validFrom: string | null;
    validTo: string | null;
    serialNumber: string | null;
    fingerprintSha256: string | null;
    trust: TrustLabel;
  }>;
  rawSignatureBytes: number;
  parseWarnings: string[];
};

export type PdfSignatureReport = {
  path: string;
  fileSize: number;
  signatures: PdfSignatureFinding[];
  signatureCount: number;
  hasSignature: boolean;
  warnings: string[];
};

/** Compact view of a PdfSignatureReport for embedding inside other command
 *  results (e.g. `signer fetch-document`, `sign`). Drops the verbose byte
 *  range + raw signature bytes + per-finding parse warnings; keeps the
 *  information a signer needs to decide whether to countersign:
 *  who-signed-it, what authority issued the cert, whether the digest
 *  verifies. `allDigestsOk: false` means at least one existing signature
 *  is broken (tamper or parse failure) — treat as a red flag. */
export type ExistingSignatureSummary = {
  count: number;
  hasSignature: boolean;
  allDigestsOk: boolean;
  signers: Array<{
    subject: string | null;
    issuer: string | null;
    validFrom: string | null;
    validTo: string | null;
    fingerprintSha256: string | null;
    trust: TrustLabel;
    digestOk: boolean | null;
  }>;
  warnings: string[];
};

export function summarizeExistingSignatures(report: PdfSignatureReport): ExistingSignatureSummary {
  const signers: ExistingSignatureSummary["signers"] = [];
  let allDigestsOk = report.signatureCount > 0;
  const warnings: string[] = [...report.warnings];
  for (const finding of report.signatures) {
    if (finding.messageDigestMatches !== true) allDigestsOk = false;
    warnings.push(...finding.parseWarnings);
    if (finding.signers.length === 0) {
      // Signature exists but no signer cert recovered — surface as an
      // entry with all-null cert fields so the caller sees the count is
      // correct.
      signers.push({
        subject: null, issuer: null, validFrom: null, validTo: null,
        fingerprintSha256: null, trust: "unknown",
        digestOk: finding.messageDigestMatches,
      });
      continue;
    }
    for (const s of finding.signers) {
      signers.push({
        subject: s.subject, issuer: s.issuer,
        validFrom: s.validFrom, validTo: s.validTo,
        fingerprintSha256: s.fingerprintSha256, trust: s.trust,
        digestOk: finding.messageDigestMatches,
      });
    }
  }
  return {
    count: report.signatureCount,
    hasSignature: report.hasSignature,
    allDigestsOk,
    signers,
    warnings,
  };
}

const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_SHA1 = "1.3.14.3.2.26";
const OID_SHA384 = "2.16.840.1.101.3.4.2.2";
const OID_SHA512 = "2.16.840.1.101.3.4.2.3";

const DIGEST_ALGOS: Record<string, string> = {
  [OID_SHA256]: "sha256",
  [OID_SHA1]: "sha1",
  [OID_SHA384]: "sha384",
  [OID_SHA512]: "sha512",
};

function findByteRanges(buffer: Buffer): Array<[number, number, number, number]> {
  const text = buffer.toString("latin1");
  const regex = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const ranges: Array<[number, number, number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ranges.push([Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]);
  }
  return ranges;
}

function findContentsAtRange(buffer: Buffer, byteRange: [number, number, number, number]): Buffer | null {
  const gapStart = byteRange[0] + byteRange[1];
  const gapEnd = byteRange[2];
  if (gapStart < 0 || gapEnd > buffer.length || gapStart >= gapEnd) return null;
  const slice = buffer.subarray(gapStart, gapEnd);
  const text = slice.toString("latin1");
  const start = text.indexOf("<");
  const end = text.lastIndexOf(">");
  if (start === -1 || end === -1 || end <= start) return null;
  const hex = text.slice(start + 1, end).replace(/\s+/g, "");
  if (hex.length === 0) return null;
  try {
    return Buffer.from(hex, "hex");
  } catch {
    return null;
  }
}

function digestBuffer(algo: string, buffer: Buffer): string {
  return crypto.createHash(algo).update(buffer).digest("hex");
}

function findSignedAttrMessageDigest(signedData: Asn1Node): { digest: string | null; algorithm: string | null } {
  const result: { digest: string | null; algorithm: string | null } = { digest: null, algorithm: null };
  function walk(node: Asn1Node): void {
    if (!node.children) return;
    for (const child of node.children) {
      if (child.tagClass === 0 && child.tagNumber === 6) {
        const oid = decodeOid(child.contents);
        if (oid === OID_MESSAGE_DIGEST) {
          const setNode = node.children.find((c) => c.tagClass === 0 && c.tagNumber === 17);
          const octet = setNode?.children?.find((c) => c.tagClass === 0 && c.tagNumber === 4);
          if (octet) {
            result.digest = octet.contents.toString("hex");
          }
        } else if (DIGEST_ALGOS[oid] && !result.algorithm) {
          result.algorithm = DIGEST_ALGOS[oid];
        }
      }
      walk(child);
    }
  }
  walk(signedData);
  return result;
}

function extractCertificates(signedData: Asn1Node): Buffer[] {
  const certs: Buffer[] = [];
  if (!signedData.children) return certs;
  for (const child of signedData.children) {
    if (child.tagClass === 2 && child.tagNumber === 0) {
      if (child.children) {
        for (const cert of child.children) {
          if (cert.tagClass === 0 && cert.tagNumber === 16) {
            certs.push(Buffer.from(cert.raw));
          }
        }
      }
    }
  }
  return certs;
}

/** Structural trust label for a certificate. We do NOT validate against a
 *  trust store — these labels are descriptive, not enforced. They tell the
 *  user at a glance whether the signature is "our local provider's self-
 *  signed cert" vs "someone else's self-signed cert" vs "a CA-rooted chain"
 *  so they don't mistake a dev-only signature for a production one. */
export type TrustLabel =
  | "self_signed_local"
  | "self_signed_other"
  | "ca_signed"
  | "unknown";

function classifyTrust(subject: string | null, issuer: string | null): TrustLabel {
  if (subject === null || issuer === null) return "unknown";
  // CN+O format on local certs always contains "Sign CLI Local Provider" in
  // the organization — see local-keys.ts loadOrCreateSignerKeyPair /
  // loadOrCreateLocalSigner. Match against that.
  const isLocal = issuer.includes("Sign CLI Local Provider")
    || issuer.includes("Sign CLI Local Signer");
  if (issuer === subject) {
    return isLocal ? "self_signed_local" : "self_signed_other";
  }
  return "ca_signed";
}

function describeCertificate(cert: Buffer): {
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  serialNumber: string | null;
  fingerprintSha256: string | null;
  trust: TrustLabel;
} {
  try {
    const x509 = new X509Certificate(cert);
    const subject = x509.subject ?? null;
    const issuer = x509.issuer ?? null;
    return {
      subject,
      issuer,
      validFrom: x509.validFrom ?? null,
      validTo: x509.validTo ?? null,
      serialNumber: x509.serialNumber ?? null,
      fingerprintSha256: x509.fingerprint256 ?? null,
      trust: classifyTrust(subject, issuer),
    };
  } catch {
    return {
      subject: null,
      issuer: null,
      validFrom: null,
      validTo: null,
      serialNumber: null,
      fingerprintSha256: digestBuffer("sha256", cert),
      trust: "unknown",
    };
  }
}

export async function inspectPdfSignatures(filePath: string): Promise<PdfSignatureReport> {
  const buffer = await readFile(filePath);
  return inspectPdfSignaturesBuffer(buffer, filePath);
}

/** Buffer-input sibling of inspectPdfSignatures. Use this when the PDF bytes
 *  are already in memory (e.g. read from the local-provider store) so we
 *  don't have to round-trip through a temp file. `virtualPath` is echoed
 *  back in the report's `path` field — pass the canonical filename when one
 *  exists, otherwise something descriptive like "request:<id>". */
export async function inspectPdfSignaturesBuffer(
  buffer: Buffer,
  virtualPath: string = "<buffer>",
): Promise<PdfSignatureReport> {
  const ranges = findByteRanges(buffer);
  const warnings: string[] = [];
  const signatures: PdfSignatureFinding[] = [];

  for (const range of ranges) {
    const findingWarnings: string[] = [];
    const [start, length1, gapEnd, length2] = range;
    if (start + length1 + (gapEnd - start - length1) + length2 > buffer.length) {
      findingWarnings.push("ByteRange extends beyond file size.");
    }
    const before = buffer.subarray(start, start + length1);
    const after = buffer.subarray(gapEnd, gapEnd + length2);
    const signedRegion = Buffer.concat([before, after]);
    const byteRangeDigest = digestBuffer("sha256", signedRegion);

    const contents = findContentsAtRange(buffer, range);
    if (!contents) {
      findingWarnings.push("Could not extract /Contents PKCS#7 blob for this signature.");
      signatures.push({
        byteRange: range,
        byteRangeDigest,
        messageDigestMatches: null,
        messageDigest: null,
        digestAlgorithm: null,
        signatureAlgorithm: null,
        signers: [],
        rawSignatureBytes: 0,
        parseWarnings: findingWarnings,
      });
      continue;
    }

    let messageDigest: string | null = null;
    let digestAlgorithm: string | null = null;
    const signers: PdfSignatureFinding["signers"] = [];
    try {
      const root = parseAsn1(contents);
      const signedDataChild = root.children?.[1]?.children?.[0];
      if (signedDataChild) {
        const md = findSignedAttrMessageDigest(signedDataChild);
        messageDigest = md.digest;
        digestAlgorithm = md.algorithm ?? "sha256";
        for (const cert of extractCertificates(signedDataChild)) {
          signers.push(describeCertificate(cert));
        }
      } else {
        findingWarnings.push("Could not locate SignedData inside PKCS#7 envelope.");
      }
    } catch (error) {
      findingWarnings.push(`PKCS#7 parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let messageDigestMatches: boolean | null = null;
    if (messageDigest && digestAlgorithm) {
      try {
        const expected = digestBuffer(digestAlgorithm, signedRegion);
        messageDigestMatches = expected === messageDigest;
      } catch (error) {
        findingWarnings.push(`Digest comparison failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    signatures.push({
      byteRange: range,
      byteRangeDigest,
      messageDigestMatches,
      messageDigest,
      digestAlgorithm,
      signatureAlgorithm: digestAlgorithm,
      signers,
      rawSignatureBytes: contents.length,
      parseWarnings: findingWarnings,
    });
  }

  if (signatures.length === 0) {
    warnings.push("No /ByteRange entries found in the PDF; the file is not signed.");
  }

  return {
    path: virtualPath,
    fileSize: buffer.length,
    signatures,
    signatureCount: signatures.length,
    hasSignature: signatures.length > 0,
    warnings,
  };
}
