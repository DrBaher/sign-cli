// RFC 3161 timestamp-token verification.
//
// `timestamp.ts` issues a TimeStampReq and parses the *status* of the
// TimeStampResp, but historically it never verified the cryptographic seal:
// it trusted any response whose status byte was 0/1, and its `containsDigest`
// check was an unsigned byte-search. That made the whole "RFC 3161 timestamp"
// feature spoofable — a MITM on the (plaintext, by default) TSA HTTP call
// could return any blob and have it recorded as proof.
//
// This module closes that gap. It performs the full CMS SignedData
// verification described by RFC 5652 §5 and RFC 3161:
//
//   1. Parse the TimeStampResp → ContentInfo → SignedData.
//   2. Extract the encapsulated TSTInfo and confirm its messageImprint
//      equals the digest we asked the TSA to stamp (binds the token to OUR
//      data — without this a valid token over someone else's data would pass).
//   3. Find the signer's certificate in the SignedData and confirm it (or a
//      cert in the same chain) carries extendedKeyUsage = id-kp-timeStamping
//      (RFC 3161 §2.3 — a TSA cert MUST have this and MUST be the only EKU).
//   4. Verify the signed-attributes' messageDigest equals sha256(TSTInfo),
//      then verify the RSA/ECDSA signature over the DER-re-encoded
//      signed-attributes using the signer cert's public key.
//   5. Optionally chain-verify the signer cert up to a provided trust anchor.
//
// All parsing reuses the project's tolerant ASN.1 reader (asn1.ts); all
// crypto uses Node's `crypto.verify` + `X509Certificate` rather than any
// hand-rolled signature math.

import crypto, { X509Certificate } from "node:crypto";
import { parseAsn1, decodeOid } from "./asn1.js";
import type { Asn1Node } from "./asn1.js";

const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";
const OID_EKU = "2.5.29.37";
const OID_KP_TIMESTAMPING = "1.3.6.1.5.5.7.3.8";

// digestAlgorithm OIDs we understand for the SignerInfo messageDigest.
const DIGEST_ALGOS: Record<string, string> = {
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
  "1.3.14.3.2.26": "sha1",
};

export type TimestampVerification = {
  // True only when every cryptographic check below passed.
  verified: boolean;
  // The token's messageImprint matched the digest we expected to be stamped.
  digestMatches: boolean;
  // The signer cert (or one in its chain) advertised id-kp-timeStamping.
  hasTimeStampingEku: boolean;
  // The CMS signature over the signed attributes verified.
  signatureValid: boolean;
  // The signer chained to the provided trust anchor (null = not checked).
  chainTrusted: boolean | null;
  // The TSA's asserted signing time (genTime in TSTInfo), ISO 8601.
  genTime: string | null;
  // The signer certificate subject, for display / audit.
  signerSubject: string | null;
  // Non-fatal notes and the specific reason verification failed, if it did.
  reasons: string[];
};

function fail(reasons: string[], partial: Partial<TimestampVerification> = {}): TimestampVerification {
  return {
    verified: false,
    digestMatches: false,
    hasTimeStampingEku: false,
    signatureValid: false,
    chainTrusted: null,
    genTime: null,
    signerSubject: null,
    reasons,
    ...partial,
  };
}

function oidOf(node: Asn1Node): string | null {
  if (node.tagClass === 0 && node.tagNumber === 6) return decodeOid(node.contents);
  return null;
}

// Walk a constructed node's direct children for the first OBJECT IDENTIFIER
// whose value equals `oid`, returning the *containing* node.
function childContainingOid(parent: Asn1Node, oid: string): Asn1Node | null {
  if (!parent.children) return null;
  for (const child of parent.children) {
    if (child.children?.some((c) => oidOf(c) === oid)) return child;
  }
  return null;
}

// Re-tag an IMPLICIT [0] signed-attributes node back to the SET OF tag the
// signature is actually computed over (RFC 5652 §5.4): same contents, leading
// byte 0xA0 → 0x31. We rebuild the length too so multi-byte lengths survive.
function reencodeSignedAttrsAsSet(signedAttrs: Asn1Node): Buffer {
  const body = signedAttrs.raw.subarray(signedAttrs.headerLength);
  const header = signedAttrs.raw.subarray(0, signedAttrs.headerLength);
  const newHeader = Buffer.from(header);
  newHeader[0] = 0x31; // universal SET OF
  return Buffer.concat([newHeader, body]);
}

function extractCertificates(signedData: Asn1Node): Buffer[] {
  const certs: Buffer[] = [];
  if (!signedData.children) return certs;
  for (const child of signedData.children) {
    // [0] IMPLICIT certificates
    if (child.tagClass === 2 && child.tagNumber === 0 && child.children) {
      for (const cert of child.children) {
        if (cert.tagClass === 0 && cert.tagNumber === 16) certs.push(Buffer.from(cert.raw));
      }
    }
  }
  return certs;
}

// A SignerInfo identifies its cert by issuer+serial (IssuerAndSerialNumber) or
// by subjectKeyIdentifier ([0]). We match on serial number, which is robust
// and avoids re-encoding the issuer DN. Returns the matching cert or, when
// only one cert is present, that one.
function selectSignerCert(certs: Buffer[], serialHex: string | null): X509Certificate | null {
  const parsed: X509Certificate[] = [];
  for (const der of certs) {
    try { parsed.push(new X509Certificate(der)); } catch { /* skip unparseable */ }
  }
  if (parsed.length === 0) return null;
  if (serialHex) {
    const want = serialHex.toLowerCase().replace(/^0+/, "");
    for (const c of parsed) {
      const have = c.serialNumber.toLowerCase().replace(/^0+/, "");
      if (have === want) return c;
    }
  }
  return parsed.length === 1 ? parsed[0] : null;
}

// id-kp-timeStamping must be present (RFC 3161 §2.3). We look at the signer
// cert's EKU extension via the raw DER (Node's X509Certificate doesn't expose
// EKU directly across all versions, so we parse it).
function certHasTimeStampingEku(certDer: Buffer): boolean {
  try {
    const cert = parseAsn1(certDer);
    // Certificate → TBSCertificate → ... → extensions [3] → SEQUENCE OF Extension
    const tbs = cert.children?.[0];
    if (!tbs?.children) return false;
    const extsWrapper = tbs.children.find((c) => c.tagClass === 2 && c.tagNumber === 3);
    const exts = extsWrapper?.children?.[0];
    if (!exts?.children) return false;
    for (const ext of exts.children) {
      const oid = ext.children?.[0] ? oidOf(ext.children[0]) : null;
      if (oid !== OID_EKU) continue;
      // value OCTET STRING wraps a SEQUENCE OF OID
      const octet = ext.children?.find((c) => c.tagClass === 0 && c.tagNumber === 4);
      if (!octet) return false;
      const ekuSeq = parseAsn1(octet.contents);
      return Boolean(ekuSeq.children?.some((o) => oidOf(o) === OID_KP_TIMESTAMPING));
    }
  } catch { /* fall through */ }
  return false;
}

function readGeneralizedTime(node: Asn1Node): string | null {
  // GeneralizedTime: YYYYMMDDHHMMSS[.fff]Z
  const s = node.contents.toString("latin1");
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}Z`;
}

/**
 * Verify an RFC 3161 TimeStampResp's cryptographic seal.
 *
 * @param responseBuffer the raw TimeStampResp DER from the TSA.
 * @param expectedDigest the digest we asked the TSA to stamp (the messageImprint
 *        must equal this — otherwise the token covers different data).
 * @param trustAnchors optional PEM/DER CA certs; when provided, the signer cert
 *        must chain to one of them. When omitted, chainTrusted is left null
 *        (signature + EKU + digest are still enforced).
 */
export function verifyTimestampToken(
  responseBuffer: Buffer,
  expectedDigest: Buffer,
  trustAnchors?: Array<string | Buffer>,
): TimestampVerification {
  let root: Asn1Node;
  try {
    root = parseAsn1(responseBuffer);
  } catch (error) {
    return fail([`TimeStampResp parse failed: ${error instanceof Error ? error.message : String(error)}`]);
  }

  // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo OPTIONAL }
  const tokenContentInfo = root.children?.find(
    (c) => c.children?.some((cc) => oidOf(cc) === OID_SIGNED_DATA),
  );
  if (!tokenContentInfo) {
    return fail(["No SignedData timeStampToken found in TimeStampResp (TSA may have returned an error/status-only response)."]);
  }
  // ContentInfo → [0] content → SignedData SEQUENCE
  const explicit = tokenContentInfo.children?.find((c) => c.tagClass === 2 && c.tagNumber === 0);
  const signedData = explicit?.children?.[0];
  if (!signedData?.children) return fail(["Malformed SignedData in timeStampToken."]);

  // EncapsulatedContentInfo → eContent [0] → OCTET STRING (TSTInfo)
  const encap = childContainingOid(signedData, OID_TST_INFO);
  const eContentExplicit = encap?.children?.find((c) => c.tagClass === 2 && c.tagNumber === 0);
  const tstOctet = eContentExplicit?.children?.find((c) => c.tagClass === 0 && c.tagNumber === 4);
  if (!tstOctet) return fail(["Could not locate TSTInfo content in the token."]);
  const tstInfoBytes = Buffer.from(tstOctet.contents);

  // --- (2) messageImprint binds the token to OUR digest ---
  let digestMatches = false;
  let genTime: string | null = null;
  try {
    const tst = parseAsn1(tstInfoBytes);
    // TSTInfo ::= SEQUENCE { version, policy, messageImprint, serialNumber, genTime, ... }
    const messageImprint = tst.children?.[2];
    const imprintDigest = messageImprint?.children?.find((c) => c.tagClass === 0 && c.tagNumber === 4);
    if (imprintDigest) {
      digestMatches = Buffer.from(imprintDigest.contents).equals(expectedDigest);
    }
    const gt = tst.children?.find((c) => c.tagClass === 0 && c.tagNumber === 24);
    if (gt) genTime = readGeneralizedTime(gt);
  } catch (error) {
    return fail([`TSTInfo parse failed: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (!digestMatches) {
    return fail(["Timestamp messageImprint does not match the expected digest — the token covers different data."], { genTime });
  }

  // --- locate SignerInfo ---
  const signerInfos = [...signedData.children].reverse().find((c) => c.tagClass === 0 && c.tagNumber === 17);
  const signerInfo = signerInfos?.children?.[0];
  if (!signerInfo?.children) return fail(["No SignerInfo in SignedData."], { digestMatches, genTime });

  // SignerInfo ::= SEQUENCE { version, sid, digestAlgorithm, signedAttrs [0] OPTIONAL, sigAlg, signature }
  const signedAttrs = signerInfo.children.find((c) => c.tagClass === 2 && c.tagNumber === 0);
  if (!signedAttrs) return fail(["SignerInfo has no signed attributes (unsupported; cannot bind signature to TSTInfo)."], { digestMatches, genTime });
  const signatureOctet = signerInfo.children[signerInfo.children.length - 1];

  // digestAlgorithm (used to hash TSTInfo for the messageDigest attr)
  const digestAlgNode = signerInfo.children[2];
  const digestAlgOid = digestAlgNode?.children?.[0] ? oidOf(digestAlgNode.children[0]) : null;
  const hashAlgo = (digestAlgOid && DIGEST_ALGOS[digestAlgOid]) || "sha256";

  // serial number from IssuerAndSerialNumber (sid), for cert selection
  let serialHex: string | null = null;
  const sid = signerInfo.children[1];
  if (sid?.children) {
    const serialNode = sid.children.find((c) => c.tagClass === 0 && c.tagNumber === 2);
    if (serialNode) serialHex = serialNode.contents.toString("hex");
  }

  // --- (3) signer cert + timeStamping EKU ---
  const certDers = extractCertificates(signedData);
  const signerCert = selectSignerCert(certDers, serialHex);
  if (!signerCert) return fail(["Could not select the signer certificate from the token."], { digestMatches, genTime });
  const signerSubject = signerCert.subject ?? null;
  const signerDer = Buffer.from(signerCert.raw);
  const hasTimeStampingEku = certHasTimeStampingEku(signerDer);
  if (!hasTimeStampingEku) {
    return fail(["Signer certificate is not marked for time-stamping (missing extendedKeyUsage id-kp-timeStamping)."], { digestMatches, genTime, signerSubject });
  }

  // --- (4a) the signed messageDigest attr must equal hash(TSTInfo) ---
  const mdAttr = childContainingOid(signedAttrs, OID_MESSAGE_DIGEST);
  const mdSet = mdAttr?.children?.find((c) => c.tagClass === 0 && c.tagNumber === 17);
  const mdValue = mdSet?.children?.find((c) => c.tagClass === 0 && c.tagNumber === 4);
  if (!mdValue) return fail(["Signed attributes have no messageDigest."], { digestMatches, genTime, signerSubject, hasTimeStampingEku });
  const tstInfoHash = crypto.createHash(hashAlgo).update(tstInfoBytes).digest();
  if (!Buffer.from(mdValue.contents).equals(tstInfoHash)) {
    return fail(["Signed messageDigest does not match the hash of TSTInfo (token internally inconsistent)."], { digestMatches, genTime, signerSubject, hasTimeStampingEku });
  }

  // --- (4b) require the contentType attr to be id-ct-TSTInfo (RFC 5652 §11.1) ---
  const ctAttr = childContainingOid(signedAttrs, OID_CONTENT_TYPE);
  const ctSet = ctAttr?.children?.find((c) => c.tagClass === 0 && c.tagNumber === 17);
  const ctOid = ctSet?.children?.[0] ? oidOf(ctSet.children[0]) : null;
  if (ctOid !== OID_TST_INFO) {
    return fail(["Signed contentType attribute is not id-ct-TSTInfo."], { digestMatches, genTime, signerSubject, hasTimeStampingEku });
  }

  // --- (4c) verify the signature over the DER SET-OF-re-tagged signed attrs ---
  const signedAttrsDer = reencodeSignedAttrsAsSet(signedAttrs);
  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      hashAlgo,
      signedAttrsDer,
      signerCert.publicKey,
      Buffer.from(signatureOctet.contents),
    );
  } catch (error) {
    return fail([`Signature verification threw: ${error instanceof Error ? error.message : String(error)}`], { digestMatches, genTime, signerSubject, hasTimeStampingEku });
  }
  if (!signatureValid) {
    return fail(["CMS signature over the timestamp's signed attributes is invalid."], { digestMatches, genTime, signerSubject, hasTimeStampingEku });
  }

  // --- (5) optional trust-anchor chaining ---
  let chainTrusted: boolean | null = null;
  if (trustAnchors && trustAnchors.length > 0) {
    chainTrusted = false;
    for (const anchor of trustAnchors) {
      try {
        const ca = new X509Certificate(anchor);
        if (signerCert.verify(ca.publicKey) || signerCert.checkIssued?.(ca)) {
          chainTrusted = true;
          break;
        }
      } catch { /* try next anchor */ }
    }
    if (!chainTrusted) {
      return fail(["Signer certificate does not chain to any provided trust anchor."], {
        digestMatches, genTime, signerSubject, hasTimeStampingEku, signatureValid, chainTrusted: false,
      });
    }
  }

  return {
    verified: true,
    digestMatches,
    hasTimeStampingEku,
    signatureValid,
    chainTrusted,
    genTime,
    signerSubject,
    reasons: [],
  };
}
