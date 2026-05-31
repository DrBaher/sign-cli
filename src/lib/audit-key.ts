// Optional keyed-HMAC integrity for the audit chain.
//
// By default the audit chain is an unkeyed SHA-256 hash chain: tamper-evident
// against a naive edit, but since the algorithm is public an attacker with
// write access to the DB file can recompute a fully self-consistent forged
// chain. Configuring an HMAC key (held OUTSIDE the database) upgrades the
// chain so that forging it requires the key, not just the algorithm.
//
// Resolution order (first hit wins):
//   1. SIGN_AUDIT_HMAC_KEY        — raw key material (utf8), or
//   2. SIGN_AUDIT_HMAC_KEY_FILE   — path to a file whose contents are the key.
//
// When neither is set, keying is OFF and the chain behaves exactly as before
// (full backward compatibility — existing chains verify unchanged).

import { readFileSync } from "node:fs";

export const HASH_ALGO_LEGACY = "sha256";
export const HASH_ALGO_HMAC = "hmac-sha256";

let cached: { key: Buffer | null } | null = null;

/** Resolve the configured audit HMAC key, or null when keying is disabled.
 *  Cached after first read; call resetAuditHmacKeyCache() in tests that mutate
 *  the env between cases. */
export function resolveAuditHmacKey(): Buffer | null {
  if (cached) return cached.key;
  const raw = process.env.SIGN_AUDIT_HMAC_KEY;
  if (raw !== undefined && raw.length > 0) {
    cached = { key: Buffer.from(raw, "utf8") };
    return cached.key;
  }
  const file = process.env.SIGN_AUDIT_HMAC_KEY_FILE;
  if (file !== undefined && file.length > 0) {
    const contents = readFileSync(file);
    if (contents.length === 0) {
      throw new Error(`SIGN_AUDIT_HMAC_KEY_FILE (${file}) is empty; provide key material or unset it.`);
    }
    cached = { key: contents };
    return cached.key;
  }
  cached = { key: null };
  return null;
}

export function resetAuditHmacKeyCache(): void {
  cached = null;
}

/** True when an HMAC key is configured (the chain should be written keyed). */
export function auditKeyingEnabled(): boolean {
  return resolveAuditHmacKey() !== null;
}
