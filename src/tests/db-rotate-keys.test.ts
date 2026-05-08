import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrCreateLocalSigner, rotateLocalSignerKeys } from "../lib/local-keys.js";

function withScopedKeyDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-rotate-keys-"));
  const previous = process.env.SIGN_LOCAL_KEY_DIR;
  process.env.SIGN_LOCAL_KEY_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.SIGN_LOCAL_KEY_DIR;
    else process.env.SIGN_LOCAL_KEY_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rotateLocalSignerKeys generates a fresh keypair + cert and reports old/new fingerprints", () => {
  withScopedKeyDir((dir) => {
    // Create the initial signer.
    const original = loadOrCreateLocalSigner();
    const originalCert = readFileSync(path.join(dir, "signer.cert.pem"), "utf8");
    const report = rotateLocalSignerKeys();
    assert.match(report.rotatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(report.oldFingerprintSha256);
    assert.match(report.newFingerprintSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(report.oldFingerprintSha256, report.newFingerprintSha256);
    // New cert on disk differs from the original.
    const newCert = readFileSync(path.join(dir, "signer.cert.pem"), "utf8");
    assert.notEqual(newCert, originalCert);
    // Backup files exist with the timestamped suffix.
    assert.ok(report.backupCertPath && existsSync(report.backupCertPath));
    assert.ok(report.backupKeyPath && existsSync(report.backupKeyPath));
    assert.equal(readFileSync(report.backupCertPath!, "utf8"), originalCert);
    void original;
  });
});

test("rotateLocalSignerKeys with no pre-existing key creates a fresh signer + reports oldFingerprint as null", () => {
  withScopedKeyDir(() => {
    const report = rotateLocalSignerKeys();
    assert.equal(report.oldFingerprintSha256, null);
    assert.equal(report.backupCertPath, null);
    assert.equal(report.backupKeyPath, null);
    assert.match(report.newFingerprintSha256, /^[0-9a-f]{64}$/);
  });
});

test("rotateLocalSignerKeys honors --key-dir override and leaves SIGN_LOCAL_KEY_DIR alone", () => {
  withScopedKeyDir((managedDir) => {
    const overrideDir = mkdtempSync(path.join(os.tmpdir(), "sign-rotate-override-"));
    try {
      const report = rotateLocalSignerKeys({ keyDir: overrideDir });
      assert.equal(report.keyDir, path.resolve(overrideDir));
      // Override dir got the new files.
      assert.ok(existsSync(path.join(overrideDir, "signer.key.pem")));
      assert.ok(existsSync(path.join(overrideDir, "signer.cert.pem")));
      // Default-managed dir untouched.
      assert.equal(readdirSync(managedDir).length, 0);
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
    }
  });
});

test("loadOrCreateLocalSigner picks up the rotated cert on next call", () => {
  withScopedKeyDir(() => {
    loadOrCreateLocalSigner();
    const report = rotateLocalSignerKeys();
    const reloaded = loadOrCreateLocalSigner();
    // Reloaded fingerprint matches the rotated key, not the original.
    const fingerprint = createHash("sha256").update(reloaded.certificateDer).digest("hex");
    assert.equal(fingerprint, report.newFingerprintSha256);
  });
});
