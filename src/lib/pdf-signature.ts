import { readFile } from "node:fs/promises";
import crypto, { X509Certificate } from "node:crypto";
import { parseAsn1, decodeOid } from "./asn1.js";
import type { Asn1Node } from "./asn1.js";

export type PdfSignatureFinding = {
  byteRange: [number, number, number, number];
  byteRangeDigest: string;
  /** Overall cryptographic verdict for this signature. `true` ONLY when the
   *  embedded messageDigest matches the digest of the signed byte range AND
   *  the signature value over the SignedAttributes verifies against the
   *  signer certificate's public key. A forged PKCS#7 (matching digest, no
   *  private key) yields `false`. `null` means we could not parse enough to
   *  decide (see parseWarnings). */
  messageDigestMatches: boolean | null;
  /** Whether the embedded messageDigest SignedAttribute equals the digest of
   *  the signed byte range. Diagnostic only — does NOT on its own imply a
   *  valid signature (the signature value still has to verify). */
  contentDigestMatches: boolean | null;
  /** Whether the RSA/ECDSA signature value over the DER-encoded
   *  SignedAttributes verifies against the signer cert's public key. */
  signatureValueVerified: boolean | null;
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

// Signature-algorithm OIDs that appear in the SignerInfo.signatureAlgorithm
// field. CMS allows either a "plain" key-encryption OID (rsaEncryption /
// ecPublicKey — the digest is named by the separate digestAlgorithm field) or
// a combined RSASSA-PKCS1 OID that pins both. We map to a Node digest name
// where known; otherwise we fall back to the SignedAttrs digestAlgorithm.
const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_SIG_ALGOS: Record<string, string | null> = {
  [OID_RSA_ENCRYPTION]: null, // digest taken from digestAlgorithm
  [OID_EC_PUBLIC_KEY]: null,
  "1.2.840.10045.4.1": "sha1", // ecdsa-with-SHA1
  "1.2.840.10045.4.3.2": "sha256", // ecdsa-with-SHA256
  "1.2.840.10045.4.3.3": "sha384", // ecdsa-with-SHA384
  "1.2.840.10045.4.3.4": "sha512", // ecdsa-with-SHA512
  "1.2.840.113549.1.1.5": "sha1", // sha1WithRSAEncryption
  "1.2.840.113549.1.1.11": "sha256", // sha256WithRSAEncryption
  "1.2.840.113549.1.1.12": "sha384", // sha384WithRSAEncryption
  "1.2.840.113549.1.1.13": "sha512", // sha512WithRSAEncryption
};

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

/** First OID found anywhere inside an AlgorithmIdentifier-shaped node. */
function firstOid(node: Asn1Node): string | null {
  if (node.tagClass === 0 && node.tagNumber === 6) return decodeOid(node.contents);
  if (node.children) {
    for (const child of node.children) {
      const oid = firstOid(child);
      if (oid) return oid;
    }
  }
  return null;
}

type SignerInfoParsed = {
  signedAttrsRaw: Buffer | null; // raw DER of the [0] IMPLICIT signedAttrs element
  signatureValue: Buffer | null;
  signatureAlgoOid: string | null;
  digestAlgoOid: string | null;
};

/** Extract the (single, first) SignerInfo's signed attributes, signature
 *  value and algorithm OIDs from a CMS SignedData node. SignedData layout
 *  (per RFC 5652):
 *    SignedData ::= SEQUENCE { version, digestAlgorithms SET, encapContentInfo,
 *      [0] certificates OPTIONAL, [1] crls OPTIONAL, signerInfos SET }
 *  SignerInfo ::= SEQUENCE { version, sid, digestAlgorithm,
 *      [0] signedAttrs OPTIONAL, signatureAlgorithm, signature, ... } */
function extractSignerInfo(signedData: Asn1Node): SignerInfoParsed {
  const result: SignerInfoParsed = {
    signedAttrsRaw: null,
    signatureValue: null,
    signatureAlgoOid: null,
    digestAlgoOid: null,
  };
  if (!signedData.children) return result;
  // signerInfos is the trailing SET OF SignerInfo (tag 0x31, universal SET).
  const signerInfosSet = [...signedData.children]
    .reverse()
    .find((c) => c.tagClass === 0 && c.tagNumber === 17);
  const signerInfo = signerInfosSet?.children?.find((c) => c.tagClass === 0 && c.tagNumber === 16);
  if (!signerInfo?.children) return result;

  const fields = signerInfo.children;
  // digestAlgorithm: the first AlgorithmIdentifier SEQUENCE after sid.
  // signedAttrs: the [0] IMPLICIT context-constructed element (tagClass 2,
  //   tagNumber 0, constructed).
  // signatureAlgorithm: the AlgorithmIdentifier SEQUENCE after signedAttrs.
  // signature: the OCTET STRING after signatureAlgorithm.
  const signedAttrs = fields.find((c) => c.tagClass === 2 && c.tagNumber === 0 && c.constructed);
  if (signedAttrs) {
    result.signedAttrsRaw = Buffer.from(signedAttrs.raw);
  }
  const seqs = fields.filter((c) => c.tagClass === 0 && c.tagNumber === 16);
  // The SignerInfo SEQUENCEs in order: [issuerAndSerial?, digestAlgo,
  // signatureAlgo]. The sid for an issuerAndSerialNumber is itself a SEQUENCE,
  // so we identify the AlgorithmIdentifiers as the SEQUENCEs whose first child
  // is an OID.
  const algIds = seqs.filter((s) => s.children?.[0]?.tagClass === 0 && s.children?.[0]?.tagNumber === 6);
  if (algIds.length >= 1) result.digestAlgoOid = firstOid(algIds[0]);
  if (algIds.length >= 2) result.signatureAlgoOid = firstOid(algIds[algIds.length - 1]);
  const sigOctet = [...fields].reverse().find((c) => c.tagClass === 0 && c.tagNumber === 4);
  if (sigOctet) result.signatureValue = Buffer.from(sigOctet.contents);
  return result;
}

/** Verify the SignerInfo's signature value over the DER-encoded
 *  SignedAttributes against the signer certificate's public key.
 *
 *  Per CMS (RFC 5652 §5.4) the signature is computed over the DER encoding of
 *  the SignedAttributes as an EXPLICIT `SET OF Attribute` (tag 0x31), NOT over
 *  the `[0] IMPLICIT` tagging (0xA0) used inside the SignerInfo. We therefore
 *  rewrite the leading tag byte to 0x31 before verifying.
 *
 *  Returns true only when the signature value cryptographically verifies. A
 *  forged PKCS#7 assembled without the private key cannot produce a valid
 *  signature value and will return false. */
function verifySignerSignature(
  signerInfo: SignerInfoParsed,
  signerCertDer: Buffer | null,
  digestAlgorithm: string,
): boolean {
  if (!signerInfo.signedAttrsRaw || !signerInfo.signatureValue || !signerCertDer) return false;
  let publicKey: crypto.KeyObject;
  try {
    const x509 = new X509Certificate(signerCertDer);
    publicKey = x509.publicKey;
  } catch {
    return false;
  }
  // Rewrite the [0] IMPLICIT tag (0xA0) to a universal SET OF tag (0x31) for
  // the bytes that were actually signed. The length octets and contents are
  // unchanged.
  const signedAttrsForVerify = Buffer.from(signerInfo.signedAttrsRaw);
  signedAttrsForVerify[0] = 0x31;
  // Determine the hash to use: a combined sig-algo OID pins it; otherwise fall
  // back to the SignedAttrs digestAlgorithm.
  let hashAlgo = digestAlgorithm;
  if (signerInfo.signatureAlgoOid && signerInfo.signatureAlgoOid in OID_SIG_ALGOS) {
    const pinned = OID_SIG_ALGOS[signerInfo.signatureAlgoOid];
    if (pinned) hashAlgo = pinned;
  }
  try {
    const verifier = crypto.createVerify(hashAlgo);
    verifier.update(signedAttrsForVerify);
    verifier.end();
    return verifier.verify(publicKey, signerInfo.signatureValue);
  } catch {
    return false;
  }
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
        contentDigestMatches: null,
        signatureValueVerified: null,
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
    let signerCertDers: Buffer[] = [];
    let signerInfo: SignerInfoParsed | null = null;
    try {
      const root = parseAsn1(contents);
      const signedDataChild = root.children?.[1]?.children?.[0];
      if (signedDataChild) {
        const md = findSignedAttrMessageDigest(signedDataChild);
        messageDigest = md.digest;
        digestAlgorithm = md.algorithm ?? "sha256";
        signerInfo = extractSignerInfo(signedDataChild);
        signerCertDers = extractCertificates(signedDataChild);
        for (const cert of signerCertDers) {
          signers.push(describeCertificate(cert));
        }
      } else {
        findingWarnings.push("Could not locate SignedData inside PKCS#7 envelope.");
      }
    } catch (error) {
      findingWarnings.push(`PKCS#7 parse failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // 1) The embedded messageDigest SignedAttribute must equal the digest of
    //    the signed byte range (detects tamper).
    let contentDigestMatches: boolean | null = null;
    if (messageDigest && digestAlgorithm) {
      try {
        const expected = digestBuffer(digestAlgorithm, signedRegion);
        contentDigestMatches = expected === messageDigest;
      } catch (error) {
        findingWarnings.push(`Digest comparison failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 2) The signature value over the DER-encoded SignedAttributes must verify
    //    against the signer cert's public key (proves possession of the
    //    private key — without this a forged PKCS#7 with a matching digest
    //    would pass). We try each embedded cert and accept if any verifies.
    let signatureValueVerified: boolean | null = null;
    if (signerInfo && digestAlgorithm) {
      if (!signerInfo.signedAttrsRaw || !signerInfo.signatureValue) {
        findingWarnings.push("SignerInfo is missing SignedAttributes or a signature value; cannot verify cryptographically.");
        signatureValueVerified = false;
      } else if (signerCertDers.length === 0) {
        findingWarnings.push("No signer certificate present in PKCS#7; cannot verify the signature value.");
        signatureValueVerified = false;
      } else {
        signatureValueVerified = signerCertDers.some((certDer) =>
          verifySignerSignature(signerInfo!, certDer, digestAlgorithm!),
        );
        if (!signatureValueVerified) {
          findingWarnings.push("Signature value did not verify against the signer certificate's public key (possible forgery or unsupported key/algorithm).");
        }
      }
    }

    // Overall verdict (messageDigestMatches): a signature is only considered
    // valid when BOTH the content digest matches AND the signature value
    // verifies. messageDigestMatches stays `null` when we could not parse
    // enough to decide either check.
    let messageDigestMatches: boolean | null = null;
    if (contentDigestMatches !== null || signatureValueVerified !== null) {
      messageDigestMatches = contentDigestMatches === true && signatureValueVerified === true;
    }

    signatures.push({
      byteRange: range,
      byteRangeDigest,
      messageDigestMatches,
      contentDigestMatches,
      signatureValueVerified,
      messageDigest,
      digestAlgorithm,
      signatureAlgorithm: signerInfo?.signatureAlgoOid ?? digestAlgorithm,
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
