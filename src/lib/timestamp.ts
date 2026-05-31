import crypto from "node:crypto";
import { retryFetch } from "./http.js";
import { parseAsn1, decodeOid } from "./asn1.js";
import type { Asn1Node } from "./asn1.js";
import { verifyTimestampToken, type TimestampVerification } from "./timestamp-verify.js";

// HTTPS by default: a timestamp is a trust anchor, so the transport to the TSA
// must not be downgradeable. (Historically this was plaintext HTTP, which —
// combined with the absence of token verification — let a network attacker
// substitute the entire "proof".) Override only for localhost test mocks via
// SIGN_ALLOW_INSECURE_TSA=1.
export const DEFAULT_TSA_URL = "https://timestamp.digicert.com";

function assertTsaUrlAllowed(tsaUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(tsaUrl);
  } catch {
    throw new Error(`Invalid TSA URL: ${JSON.stringify(tsaUrl)}`);
  }
  if (parsed.protocol === "https:") return;
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  const allowInsecure = ["1", "true", "yes"].includes((process.env.SIGN_ALLOW_INSECURE_TSA ?? "").toLowerCase());
  if (parsed.protocol === "http:" && (isLocalhost || allowInsecure)) return;
  throw new Error(
    `Refusing to use a non-HTTPS TSA URL (${parsed.protocol}//${parsed.hostname}). ` +
    `A timestamp is a trust anchor and must not travel over plaintext. ` +
    `Use an https:// TSA, or set SIGN_ALLOW_INSECURE_TSA=1 for a trusted local test server.`,
  );
}
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

function encodeAsn1Length(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

function asn1Element(tag: number, contents: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeAsn1Length(contents.length), contents]);
}

function encodeOid(oid: string): Buffer {
  const arcs = oid.split(".").map(Number);
  const bytes: number[] = [arcs[0] * 40 + arcs[1]];
  for (let i = 2; i < arcs.length; i += 1) {
    let arc = arcs[i];
    const stack: number[] = [arc & 0x7f];
    arc >>= 7;
    while (arc > 0) {
      stack.unshift((arc & 0x7f) | 0x80);
      arc >>= 7;
    }
    bytes.push(...stack);
  }
  return asn1Element(0x06, Buffer.from(bytes));
}

function buildTimeStampRequest(digest: Buffer, hashOid: string): Buffer {
  const algId = asn1Element(0x30, Buffer.concat([encodeOid(hashOid), Buffer.from([0x05, 0x00])]));
  const messageImprint = asn1Element(0x30, Buffer.concat([algId, asn1Element(0x04, digest)]));
  const version = asn1Element(0x02, Buffer.from([0x01]));
  const certReq = asn1Element(0x01, Buffer.from([0xff]));
  return asn1Element(0x30, Buffer.concat([version, messageImprint, certReq]));
}

export async function issueRfc3161Timestamp(input: {
  digest: Buffer;
  hashAlgorithm?: "sha256";
  tsaUrl?: string;
}): Promise<{ tsaUrl: string; responseBuffer: Buffer; statusBytes: Buffer }> {
  const tsaUrl = input.tsaUrl ?? process.env.SIGN_TSA_URL ?? DEFAULT_TSA_URL;
  assertTsaUrlAllowed(tsaUrl);
  const requestBuffer = buildTimeStampRequest(input.digest, OID_SHA256);
  const response = await retryFetch(tsaUrl, {
    method: "POST",
    headers: { "content-type": "application/timestamp-query" },
    body: new Uint8Array(requestBuffer),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Timestamp request failed (${response.status}): ${text || response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const responseBuffer = Buffer.from(arrayBuffer);
  return { tsaUrl, responseBuffer, statusBytes: responseBuffer.subarray(0, Math.min(responseBuffer.length, 16)) };
}

export type TimestampInspection = {
  bytes: number;
  granted: boolean;
  containsDigest: boolean | null;
  // The full CMS seal check (signature + signer EKU + messageImprint binding).
  // `cryptographicallyVerified` is the authoritative trust signal; `granted`
  // (the PKIStatus byte) and `containsDigest` (a byte-search) are retained for
  // backward compatibility but must NOT be relied on alone. Present only when
  // an expectedDigest was supplied to inspectTimestampResponse.
  cryptographicallyVerified: boolean | null;
  verification: TimestampVerification | null;
  parseWarnings: string[];
};

function findOctetStringWithBytes(node: Asn1Node, target: Buffer): boolean {
  if (node.tagClass === 0 && node.tagNumber === 4 && node.contents.equals(target)) {
    return true;
  }
  if (node.children) {
    for (const child of node.children) {
      if (findOctetStringWithBytes(child, target)) return true;
    }
  }
  return false;
}

export function inspectTimestampResponse(
  buffer: Buffer,
  expectedDigest?: Buffer,
  trustAnchors?: Array<string | Buffer>,
): TimestampInspection {
  const warnings: string[] = [];
  let granted = false;
  let containsDigest: boolean | null = null;
  let cryptographicallyVerified: boolean | null = null;
  let verification: TimestampVerification | null = null;

  try {
    const root = parseAsn1(buffer);
    const status = root.children?.[0];
    if (status?.children?.[0]) {
      const statusValue = status.children[0].contents[0];
      granted = statusValue === 0 || statusValue === 1;
    }
    if (expectedDigest) {
      containsDigest = findOctetStringWithBytes(root, expectedDigest);
    }
  } catch (error) {
    warnings.push(`TimestampResp parse failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The authoritative check: full CMS verification binding the token's
  // signature + signer's timeStamping EKU + messageImprint to our digest.
  // Only meaningful when we know which digest the token is supposed to cover.
  if (expectedDigest) {
    verification = verifyTimestampToken(buffer, expectedDigest, trustAnchors);
    cryptographicallyVerified = verification.verified;
    if (!verification.verified) {
      warnings.push(...verification.reasons);
    }
  }

  return {
    bytes: buffer.length,
    granted,
    containsDigest,
    cryptographicallyVerified,
    verification,
    parseWarnings: warnings,
  };
}

export function digestForChainHead(hashSelf: string): Buffer {
  return crypto.createHash("sha256").update(Buffer.from(hashSelf, "hex")).digest();
}
