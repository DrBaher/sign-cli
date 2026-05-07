import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { loadOrCreateSignerKeyPair } from "../lib/local-keys.js";
import {
  createSigningRequest,
  getRequestSnapshot,
  sendSigningRequest,
  signSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-per-signer-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousKeys = process.env.SIGN_LOCAL_KEY_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_KEY_DIR = path.join(dir, "keys");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousKeys === undefined) delete process.env.SIGN_LOCAL_KEY_DIR;
    else process.env.SIGN_LOCAL_KEY_DIR = previousKeys;
    if (previousAuto === undefined) delete process.env.SIGN_LOCAL_AUTOCOMPLETE;
    else process.env.SIGN_LOCAL_AUTOCOMPLETE = previousAuto;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return documentPath;
}

test("loadOrCreateSignerKeyPair creates a per-email cert with the signer's CN", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const pair = loadOrCreateSignerKeyPair({ email: "alice@example.com", name: "Alice Example" });
    assert.match(pair.subjectCommonName, /alice@example\.com/);
    const cert = new X509Certificate(pair.certificateDer);
    assert.match(cert.subject, /alice@example\.com/);
    assert.equal(typeof pair.fingerprintSha256, "string");
    assert.equal(pair.fingerprintSha256.length, 64);
    // Key files are persisted under SIGN_LOCAL_KEY_DIR/signers/<slug>/
    const keyDir = path.join(process.env.SIGN_LOCAL_KEY_DIR!, "signers", "alice_example.com");
    assert.ok(existsSync(path.join(keyDir, "signer.key.pem")));
    assert.ok(existsSync(path.join(keyDir, "signer.cert.pem")));
  });
});

test("loadOrCreateSignerKeyPair returns the same fingerprint on a second call (key is persistent)", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const a = loadOrCreateSignerKeyPair({ email: "alice@example.com", name: "Alice" });
    const b = loadOrCreateSignerKeyPair({ email: "alice@example.com", name: "Alice (renamed locally)" });
    assert.equal(a.fingerprintSha256, b.fingerprintSha256);
  });
});

test("two different signers get distinct certs and fingerprints", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const a = loadOrCreateSignerKeyPair({ email: "alice@example.com", name: "Alice" });
    const b = loadOrCreateSignerKeyPair({ email: "bob@example.com", name: "Bob" });
    assert.notEqual(a.fingerprintSha256, b.fingerprintSha256);
    assert.notEqual(a.certificatePem, b.certificatePem);
  });
});

test("signLocalDocument records per-signer cert fingerprint + subject in signedBy", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-per-signer-flow-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const created = createSigningRequest(db, {
        title: "Per-signer test",
        documentPath,
        signers: [
          { name: "Alice", email: "alice@example.com", order: 1 },
          { name: "Bob", email: "bob@example.com", order: 2 },
        ],
        tokenTtlMinutes: 30,
        provider: "local",
        autoApprove: true,
      });
      await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
      const aliceToken = created.tokens.find((t) => t.signer.email === "alice@example.com")!.token;
      const bobToken = created.tokens.find((t) => t.signer.email === "bob@example.com")!.token;
      signSigningRequest(db, { requestId: created.requestId, token: aliceToken });
      signSigningRequest(db, { requestId: created.requestId, token: bobToken });

      const snap = getRequestSnapshot(db, created.requestId);
      assert.equal(snap.signedBy?.length, 2);
      const alice = snap.signedBy!.find((s) => s.email === "alice@example.com")!;
      const bob = snap.signedBy!.find((s) => s.email === "bob@example.com")!;
      assert.match(alice.certSubjectCommonName ?? "", /alice@example\.com/);
      assert.match(bob.certSubjectCommonName ?? "", /bob@example\.com/);
      assert.equal(typeof alice.certFingerprintSha256, "string");
      assert.equal(typeof bob.certFingerprintSha256, "string");
      assert.notEqual(alice.certFingerprintSha256, bob.certFingerprintSha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("the same signer reuses their cert fingerprint across requests", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-per-signer-stable-"));
    const documentPath = makeFixturePdf(dir);
    try {
      const fingerprints: string[] = [];
      for (const title of ["Round 1", "Round 2"]) {
        const c = createSigningRequest(db, {
          title,
          documentPath,
          signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
          tokenTtlMinutes: 30,
          provider: "local",
          autoApprove: true,
        });
        await sendSigningRequest(db, { requestId: c.requestId, provider: "local", testMode: true });
        signSigningRequest(db, { requestId: c.requestId, token: c.tokens[0].token });
        const snap = getRequestSnapshot(db, c.requestId);
        fingerprints.push(snap.signedBy![0].certFingerprintSha256!);
      }
      assert.equal(fingerprints[0], fingerprints[1], "alice's cert fingerprint must be stable across requests");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});
