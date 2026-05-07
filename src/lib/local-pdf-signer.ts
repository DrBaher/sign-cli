import crypto, { createSign } from "node:crypto";
import { extractCertSerialAndIssuer, loadOrCreateLocalSigner } from "./local-keys.js";
import {
  asn1,
  asn1AlgorithmIdentifier,
  asn1ContextConstructed,
  asn1ContextImplicit,
  asn1Integer,
  asn1Oid,
  asn1OctetString,
  asn1Sequence,
  asn1Set,
} from "./asn1-encode.js";

const OID_DATA = "1.2.840.113549.1.7.1";
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";

function asn1UtcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const value = `${String(date.getUTCFullYear()).slice(2)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return asn1(0x17, Buffer.from(value, "ascii"));
}

function buildSignedAttributes(messageDigest: Buffer, signingTime: Date): Buffer {
  const contentTypeAttr = asn1Sequence(asn1Oid(OID_CONTENT_TYPE), asn1Set(asn1Oid(OID_DATA)));
  const messageDigestAttr = asn1Sequence(asn1Oid(OID_MESSAGE_DIGEST), asn1Set(asn1OctetString(messageDigest)));
  const signingTimeAttr = asn1Sequence(asn1Oid(OID_SIGNING_TIME), asn1Set(asn1UtcTime(signingTime)));
  return asn1Sequence(contentTypeAttr, messageDigestAttr, signingTimeAttr);
}

function buildPkcs7(input: {
  messageDigest: Buffer;
  certificateDer: Buffer;
  privateKeyPem: string;
  signingTime: Date;
}): Buffer {
  const signedAttributes = buildSignedAttributes(input.messageDigest, input.signingTime);
  // For signing we need DER SET form: replace SEQUENCE tag with SET tag (0x31 = SET, constructed)
  const signedAttrsForSigning = Buffer.concat([Buffer.from([0x31]), signedAttributes.subarray(1)]);
  const signature = createSign("RSA-SHA256").update(signedAttrsForSigning).sign(input.privateKeyPem);

  const { serialNumber, issuerDer } = extractCertSerialAndIssuer(input.certificateDer);
  const issuerAndSerial = asn1Sequence(issuerDer, asn1Integer(serialNumber));

  // SignerInfo's signedAttrs is [0] IMPLICIT SET OF Attribute — context-constructed, not primitive.
  const signedAttrsContents = signedAttributes.subarray(getHeaderLength(signedAttributes));
  const signedAttrsImplicit = asn1ContextConstructed(0, signedAttrsContents);

  const signerInfo = asn1Sequence(
    asn1Integer(1),
    issuerAndSerial,
    asn1AlgorithmIdentifier(OID_SHA256),
    signedAttrsImplicit,
    asn1AlgorithmIdentifier(OID_RSA_ENCRYPTION),
    asn1OctetString(signature),
  );

  const signedData = asn1Sequence(
    asn1Integer(1),
    asn1Set(asn1AlgorithmIdentifier(OID_SHA256)),
    asn1Sequence(asn1Oid(OID_DATA)),
    asn1ContextConstructed(0, input.certificateDer),
    asn1Set(signerInfo),
  );

  const cms = asn1Sequence(
    asn1Oid(OID_SIGNED_DATA),
    asn1ContextConstructed(0, signedData),
  );
  return cms;
}

function getHeaderLength(buffer: Buffer): number {
  const lengthByte = buffer[1];
  if ((lengthByte & 0x80) === 0) return 2;
  return 2 + (lengthByte & 0x7f);
}

const PLACEHOLDER_BYTES = 16384;

function buildPdfWithSigPlaceholder(originalPdf: Buffer): { document: Buffer; byteRangeOffset: number; byteRangeLength: number; contentsOffset: number; contentsHexLength: number } {
  const trimmed = originalPdf.subarray(0, originalPdf.length);
  const newline = Buffer.from("\n");
  const sigObjId = "1000 0";
  const annotObjId = "1001 0";
  const acroFormObjId = "1002 0";

  const byteRangePlaceholder = `[0 0000000000 0000000000 0000000000]`;
  const contentsPlaceholder = `<${"00".repeat(PLACEHOLDER_BYTES / 2)}>`;
  const sigObject = `${sigObjId} obj\n<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /adbe.pkcs7.detached\n/ByteRange ${byteRangePlaceholder}\n/Contents ${contentsPlaceholder}\n>>\nendobj\n`;
  const annotObject = `${annotObjId} obj\n<<\n/Type /Annot\n/Subtype /Widget\n/F 4\n/Rect [0 0 0 0]\n/FT /Sig\n/T (Sign CLI Local Signature)\n/V ${sigObjId} R\n>>\nendobj\n`;
  const acroFormObject = `${acroFormObjId} obj\n<<\n/Fields [${annotObjId} R]\n/SigFlags 3\n>>\nendobj\n`;

  const incremental = Buffer.concat([
    trimmed,
    newline,
    Buffer.from(sigObject, "latin1"),
    Buffer.from(annotObject, "latin1"),
    Buffer.from(acroFormObject, "latin1"),
  ]);

  const sigStart = trimmed.length + 1;
  const contentsTag = "/Contents ";
  const contentsLocalIndex = sigObject.indexOf(contentsTag) + contentsTag.length;
  const contentsOffset = sigStart + contentsLocalIndex;
  const contentsHexLength = contentsPlaceholder.length;

  const byteRangeTag = "/ByteRange ";
  const byteRangeLocalIndex = sigObject.indexOf(byteRangeTag) + byteRangeTag.length;
  const byteRangeOffset = sigStart + byteRangeLocalIndex;
  const byteRangeLength = byteRangePlaceholder.length;

  return { document: incremental, byteRangeOffset, byteRangeLength, contentsOffset, contentsHexLength };
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}

export type LocalPdfSignResult = {
  signedPdf: Buffer;
  signerSubject: string;
  signerFingerprintSha256: string;
  signedAt: string;
};

export function signPdfLocally(originalPdf: Buffer, options: { signingTime?: Date } = {}): LocalPdfSignResult {
  const signer = loadOrCreateLocalSigner();
  const { document, byteRangeOffset, byteRangeLength, contentsOffset, contentsHexLength } = buildPdfWithSigPlaceholder(originalPdf);

  const beforeStart = 0;
  const beforeLength = contentsOffset;
  const afterStart = contentsOffset + contentsHexLength;
  const afterLength = document.length - afterStart;
  const byteRangeStr = `[${beforeStart} ${beforeLength} ${afterStart} ${afterLength}]`.padEnd(byteRangeLength, " ");
  document.write(byteRangeStr, byteRangeOffset, "latin1");

  const before = document.subarray(beforeStart, beforeStart + beforeLength);
  const after = document.subarray(afterStart, afterStart + afterLength);
  const messageDigest = crypto.createHash("sha256").update(before).update(after).digest();

  const cms = buildPkcs7({
    messageDigest,
    certificateDer: signer.certificateDer,
    privateKeyPem: signer.privateKeyPem,
    signingTime: options.signingTime ?? new Date(),
  });

  if (cms.length * 2 + 2 > contentsHexLength) {
    throw new Error(`PKCS#7 signature is larger than the placeholder (${cms.length * 2} bytes vs ${contentsHexLength - 2}).`);
  }
  const hex = cms.toString("hex").padEnd(contentsHexLength - 2, "0");
  const wrapped = `<${hex}>`;
  document.write(wrapped, contentsOffset, "latin1");

  return {
    signedPdf: document,
    signerSubject: signer.certificate.subject ?? "unknown",
    signerFingerprintSha256: signer.certificate.fingerprint256 ?? "",
    signedAt: (options.signingTime ?? new Date()).toISOString(),
  };
}
