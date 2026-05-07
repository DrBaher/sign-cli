import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateKeyPairSync, X509Certificate, createSign } from "node:crypto";
import { parseAsn1 } from "./asn1.js";
import {
  asn1,
  asn1AlgorithmIdentifier,
  asn1ContextConstructed,
  asn1Integer,
  asn1Oid,
  asn1Sequence,
  asn1Set,
  ASN1_NULL,
} from "./asn1-encode.js";

export const LOCAL_KEY_DIR = process.env.SIGN_LOCAL_KEY_DIR ?? "./data/local-keys";
const KEY_FILE = "signer.key.pem";
const CERT_FILE = "signer.cert.pem";

const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const OID_COMMON_NAME = "2.5.4.3";
const OID_ORGANIZATION = "2.5.4.10";

export type LocalSignerKeyPair = {
  privateKeyPem: string;
  certificatePem: string;
  certificateDer: Buffer;
  certificate: X509Certificate;
};

function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, "0");
  const value = `${String(date.getUTCFullYear()).slice(2)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return asn1(0x17, Buffer.from(value, "ascii"));
}

function asn1RDN(oid: string, value: string): Buffer {
  return asn1Set(asn1Sequence(asn1Oid(oid), asn1(0x0c, Buffer.from(value, "utf8"))));
}

function asn1Name(commonName: string, organization: string): Buffer {
  return asn1Sequence(
    asn1RDN(OID_COMMON_NAME, commonName),
    asn1RDN(OID_ORGANIZATION, organization),
  );
}

function pemToDer(pem: string): Buffer {
  const body = pem.replace(/-----BEGIN [^-]+-----/u, "").replace(/-----END [^-]+-----/u, "").replace(/\s+/gu, "");
  return Buffer.from(body, "base64");
}

function buildSelfSignedCertificate(privateKeyPem: string, publicKeyDer: Buffer, options: { commonName: string; organization: string }): { certificateDer: Buffer; certificatePem: string } {
  const tbsCertificate = asn1Sequence(
    asn1ContextConstructed(0, asn1Integer(2)),
    asn1Integer(Math.floor(Date.now() / 1000)),
    asn1AlgorithmIdentifier(OID_SHA256_WITH_RSA),
    asn1Name(options.commonName, options.organization),
    asn1Sequence(utcTime(new Date()), utcTime(new Date(Date.now() + 365 * 86400_000 * 5))),
    asn1Name(options.commonName, options.organization),
    publicKeyDer,
  );
  const signer = createSign("RSA-SHA256");
  signer.update(tbsCertificate);
  const signature = signer.sign(privateKeyPem);
  const certificateDer = asn1Sequence(
    tbsCertificate,
    asn1AlgorithmIdentifier(OID_SHA256_WITH_RSA),
    asn1(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  );
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${certificateDer.toString("base64").replace(/(.{64})/g, "$1\n").trim()}\n-----END CERTIFICATE-----\n`;
  return { certificateDer, certificatePem };
}

export function loadOrCreateLocalSigner(options: { commonName?: string; organization?: string } = {}): LocalSignerKeyPair {
  const dir = path.resolve(LOCAL_KEY_DIR);
  const keyPath = path.join(dir, KEY_FILE);
  const certPath = path.join(dir, CERT_FILE);

  if (existsSync(keyPath) && existsSync(certPath)) {
    const privateKeyPem = readFileSync(keyPath, "utf8");
    const certificatePem = readFileSync(certPath, "utf8");
    const certificateDer = pemToDer(certificatePem);
    const certificate = new X509Certificate(certificateDer);
    return { privateKeyPem, certificatePem, certificateDer, certificate };
  }

  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const cert = buildSelfSignedCertificate(privateKeyPem, publicKeyDer, {
    commonName: options.commonName ?? "Sign CLI Local Signer",
    organization: options.organization ?? "Sign CLI Local Provider",
  });
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(certPath, cert.certificatePem, { mode: 0o644 });
  const certificate = new X509Certificate(cert.certificateDer);
  return { privateKeyPem, certificatePem: cert.certificatePem, certificateDer: cert.certificateDer, certificate };
}

export function extractCertSerialAndIssuer(certificateDer: Buffer): { serialNumber: Buffer; issuerDer: Buffer } {
  const root = parseAsn1(certificateDer);
  const tbs = root.children?.[0];
  if (!tbs?.children) throw new Error("Could not parse TBSCertificate.");
  const versionMaybe = tbs.children[0];
  const startsWithVersion = versionMaybe.tagClass === 2 && versionMaybe.tagNumber === 0;
  const serial = tbs.children[startsWithVersion ? 1 : 0];
  const issuer = tbs.children[startsWithVersion ? 3 : 2];
  return { serialNumber: Buffer.from(serial.contents), issuerDer: Buffer.from(issuer.raw) };
}
