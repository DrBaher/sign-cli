import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { createSign, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHttpApiServer } from "../lib/http-api.js";
import {
  asn1,
  asn1AlgorithmIdentifier,
  asn1ContextConstructed,
  asn1Integer,
  asn1Oid,
  asn1Sequence,
  asn1Set,
} from "../lib/asn1-encode.js";
import { createDb, makeTempDb } from "./helpers.js";

// Build a minimal self-signed RSA cert/key for the TLS test. Mirrors
// loadOrCreateLocalSigner without relying on its on-disk side-effects.
function makeSelfSignedCert(commonName: string): { certificatePem: string; privateKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const OID_SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
  const OID_COMMON_NAME = "2.5.4.3";
  const OID_ORGANIZATION = "2.5.4.10";
  const utc = (date: Date): Buffer => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const value = `${String(date.getUTCFullYear()).slice(2)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
    return asn1(0x17, Buffer.from(value, "ascii"));
  };
  const rdn = (oid: string, value: string): Buffer =>
    asn1Set(asn1Sequence(asn1Oid(oid), asn1(0x0c, Buffer.from(value, "utf8"))));
  const name = asn1Sequence(rdn(OID_COMMON_NAME, commonName), rdn(OID_ORGANIZATION, "tls-test"));
  const tbs = asn1Sequence(
    asn1ContextConstructed(0, asn1Integer(2)),
    asn1Integer(Math.floor(Date.now() / 1000)),
    asn1AlgorithmIdentifier(OID_SHA256_WITH_RSA),
    name,
    asn1Sequence(utc(new Date()), utc(new Date(Date.now() + 365 * 86400_000))),
    name,
    publicKeyDer,
  );
  const signer = createSign("RSA-SHA256");
  signer.update(tbs);
  const signature = signer.sign(privateKeyPem);
  const certDer = asn1Sequence(
    tbs,
    asn1AlgorithmIdentifier(OID_SHA256_WITH_RSA),
    asn1(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  );
  const certificatePem = `-----BEGIN CERTIFICATE-----\n${certDer.toString("base64").replace(/(.{64})/g, "$1\n").trim()}\n-----END CERTIFICATE-----\n`;
  void X509Certificate; // referenced for type-only import sanity
  return { certificatePem, privateKeyPem };
}

test("startHttpApiServer with --tls listens on https and verifies against the embedded cert", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-http-tls-"));
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  const { certificatePem, privateKeyPem } = makeSelfSignedCert("127.0.0.1");
  writeFileSync(certPath, certificatePem);
  writeFileSync(keyPath, privateKeyPem);

  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({ db, port: 0, tls: { certPath, keyPath } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  try {
    assert.ok(server instanceof https.Server, "TLS option must produce an https.Server");
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    // Use the cert as the CA. The minimal self-signed cert doesn't carry SAN
    // entries, so skip hostname verification — the chain validity check still
    // exercises the TLS termination path we care about.
    const agent = new https.Agent({ ca: certificatePem });
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/health",
          method: "GET",
          agent,
          checkServerIdentity: () => undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      req.on("error", reject);
      req.end();
    });
    const parsed = JSON.parse(body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.version.split(".").length, 3);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    db.close();
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startHttpApiServer without --tls returns a plain http.Server", () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const server = startHttpApiServer({ db, port: 0 });
  try {
    assert.ok(server instanceof http.Server);
    assert.ok(!(server instanceof https.Server));
  } finally {
    server.close();
    db.close();
    cleanup();
  }
});
