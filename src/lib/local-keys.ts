import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, createSign, generateKeyPairSync, X509Certificate } from "node:crypto";
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

function localKeyDir(): string {
  return process.env.SIGN_LOCAL_KEY_DIR ?? "./data/local-keys";
}
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

function loadOrCreateAtPath(
  dir: string,
  options: { commonName: string; organization: string },
): LocalSignerKeyPair {
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
  const cert = buildSelfSignedCertificate(privateKeyPem, publicKeyDer, options);
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(certPath, cert.certificatePem, { mode: 0o644 });
  const certificate = new X509Certificate(cert.certificateDer);
  return { privateKeyPem, certificatePem: cert.certificatePem, certificateDer: cert.certificateDer, certificate };
}

export function loadOrCreateLocalSigner(options: { commonName?: string; organization?: string } = {}): LocalSignerKeyPair {
  return loadOrCreateAtPath(path.resolve(localKeyDir()), {
    commonName: options.commonName ?? "Sign CLI Local Signer",
    organization: options.organization ?? "Sign CLI Local Provider",
  });
}

function emailSlug(email: string): string {
  return email.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "_");
}

export function loadOrCreateSignerKeyPair(input: {
  email: string;
  name?: string;
  organization?: string;
}): LocalSignerKeyPair & { fingerprintSha256: string; subjectCommonName: string } {
  const subjectCommonName = input.name ? `${input.name} <${input.email}>` : input.email;
  const dir = path.join(path.resolve(localKeyDir()), "signers", emailSlug(input.email));
  const keyPair = loadOrCreateAtPath(dir, {
    commonName: subjectCommonName,
    organization: input.organization ?? "Sign CLI Local Provider — per-signer identity",
  });
  const fingerprintSha256 = createHash("sha256").update(keyPair.certificateDer).digest("hex");
  return { ...keyPair, fingerprintSha256, subjectCommonName };
}

// Rotate the local signer keypair: back up the existing key+cert with a
// timestamped suffix, then generate a fresh keypair + self-signed cert in
// place. Returns the old/new fingerprints + backup paths so the caller can
// record the rotation in an external log if they want a persistent trail.
//
// Limitation: existing receipt manifests stay signed by the OLD key. They
// remain verifiable as long as the .bak.<timestamp>.cert.pem is around, but
// re-signing every prior receipt is a separate operation (not implemented
// yet — would require walking artifacts and re-signing each manifest).
export type RotateLocalKeysReport = {
  rotatedAt: string;
  oldFingerprintSha256: string | null;
  newFingerprintSha256: string;
  backupKeyPath: string | null;
  backupCertPath: string | null;
  keyDir: string;
};

export function rotateLocalSignerKeys(input: {
  keyDir?: string;
  commonName?: string;
  organization?: string;
  now?: Date;
} = {}): RotateLocalKeysReport {
  const dir = path.resolve(input.keyDir ?? localKeyDir());
  mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, KEY_FILE);
  const certPath = path.join(dir, CERT_FILE);
  const now = input.now ?? new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");

  let backupKeyPath: string | null = null;
  let backupCertPath: string | null = null;
  let oldFingerprintSha256: string | null = null;
  if (existsSync(certPath)) {
    const oldCertPem = readFileSync(certPath, "utf8");
    const oldCertDer = pemToDer(oldCertPem);
    oldFingerprintSha256 = createHash("sha256").update(oldCertDer).digest("hex");
    backupCertPath = path.join(dir, `signer.${stamp}.bak.cert.pem`);
    copyFileSync(certPath, backupCertPath);
    if (existsSync(keyPath)) {
      backupKeyPath = path.join(dir, `signer.${stamp}.bak.key.pem`);
      copyFileSync(keyPath, backupKeyPath);
      // Lock down the backup key the same way as the live key.
      try { chmodSync(backupKeyPath, 0o600); } catch { /* best-effort */ }
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const cert = buildSelfSignedCertificate(privateKeyPem, publicKeyDer, {
    commonName: input.commonName ?? "Sign CLI Local Signer",
    organization: input.organization ?? "Sign CLI Local Provider",
  });
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  writeFileSync(certPath, cert.certificatePem, { mode: 0o644 });
  const newFingerprintSha256 = createHash("sha256").update(cert.certificateDer).digest("hex");

  return {
    rotatedAt: now.toISOString(),
    oldFingerprintSha256,
    newFingerprintSha256,
    backupKeyPath,
    backupCertPath,
    keyDir: dir,
  };
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
