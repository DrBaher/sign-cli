import { createVerify, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { sha256, stableStringify } from "./util.js";

export type ReceiptFileCheck = {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
};

export type ReceiptChainCheck = {
  events: number;
  ok: boolean;
  break: { kind: string; eventId: number; expected: string | null; actual: string | null } | null;
};

export type ReceiptVerificationResult = {
  ok: boolean;
  bundleDir: string;
  manifestVerified: boolean;
  manifestSha256: string;
  signerSubject: string | null;
  /** SHA-256 fingerprint of the cert embedded in the bundle (manifest.cert.pem). */
  signerFingerprintSha256: string | null;
  /** Whether an --expect-fingerprint was supplied and matched the embedded
   *  cert. `null` when no expectation was given (no pinning performed). */
  fingerprintPinned: boolean | null;
  /** Caveat describing the trust model. Without pinning, `ok` means only that
   *  the bundle is internally consistent (manifest signs its files, the chain
   *  is intact) — it does NOT establish that the embedded cert belongs to a
   *  trusted signer, because the bundle vouches for its own cert. */
  trustNote: string;
  files: ReceiptFileCheck[];
  chain: ReceiptChainCheck | null;
  errors: string[];
};

export type VerifyReceiptOptions = {
  /** Pin the embedded signer cert to this SHA-256 fingerprint (hex, with or
   *  without colons / case-insensitive). When set and the embedded cert does
   *  not match, verification fails. */
  expectFingerprintSha256?: string;
};

const TRUST_NOTE_PINNED =
  "Signer cert fingerprint matched --expect-fingerprint.";
const TRUST_NOTE_UNPINNED =
  "ok means internal consistency only (manifest signature + file hashes + audit chain). " +
  "The embedded cert is self-vouching; pass --expect-fingerprint to pin the signer identity.";

function normalizeFingerprint(fp: string): string {
  return fp.replace(/:/g, "").trim().toLowerCase();
}

type Manifest = {
  requestId?: string;
  generatedAt?: string;
  chainValid?: boolean;
  files?: Array<{ name: string; sha256: string; bytes: number }>;
};

type AuditEvent = {
  id: number;
  event_type: string;
  payload_json: string;
  hash_prev: string | null;
  hash_self: string;
  created_at: string;
};

type AuditPayload = {
  events?: AuditEvent[];
  request?: { id?: string };
};

/** Resolve a manifest entry's file name against the bundle root and assert it
 *  stays inside. Rejects absolute paths and ../ traversal. Returns null on
 *  escape so the caller can record an error instead of reading the file. */
function containedFilePath(bundleDir: string, name: string): string | null {
  if (path.isAbsolute(name)) return null;
  const resolved = path.resolve(bundleDir, name);
  const relative = path.relative(bundleDir, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function checkFiles(bundleDir: string, manifest: Manifest, errors: string[]): ReceiptFileCheck[] {
  if (!Array.isArray(manifest.files)) {
    errors.push("manifest.json has no files[] array.");
    return [];
  }
  const checks: ReceiptFileCheck[] = [];
  for (const entry of manifest.files) {
    // Defensive validation: a malformed/hostile manifest can carry a
    // non-string name (→ used to crash with a TypeError → INTERNAL verdict)
    // or a traversal/absolute path (→ used to read files outside the bundle).
    // Validate, contain, and record a failed check rather than throwing.
    const name = entry && typeof entry.name === "string" ? entry.name : null;
    const expected = entry && typeof entry.sha256 === "string" ? entry.sha256 : "";
    if (name === null) {
      errors.push("manifest.files[] entry has a non-string `name`; skipping.");
      checks.push({ name: String((entry as { name?: unknown })?.name ?? ""), expected, actual: "", ok: false });
      continue;
    }
    const filePath = containedFilePath(bundleDir, name);
    if (!filePath) {
      errors.push(`Bundle file escapes the bundle directory (refused): ${name}`);
      checks.push({ name, expected, actual: "", ok: false });
      continue;
    }
    if (!existsSync(filePath)) {
      checks.push({ name, expected, actual: "", ok: false });
      errors.push(`Bundle file missing: ${name}`);
      continue;
    }
    const actual = sha256(readFileSync(filePath));
    checks.push({ name, expected, actual, ok: actual === expected });
  }
  return checks;
}

function checkAuditChain(bundleDir: string, errors: string[]): ReceiptChainCheck | null {
  const auditPath = path.join(bundleDir, "audit.json");
  if (!existsSync(auditPath)) {
    errors.push("Bundle is missing audit.json.");
    return null;
  }
  let parsed: AuditPayload;
  try {
    parsed = JSON.parse(readFileSync(auditPath, "utf8")) as AuditPayload;
  } catch (error) {
    errors.push(`audit.json is not valid JSON: ${(error as Error).message}`);
    return null;
  }
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  let previousHash: string | null = null;
  for (const event of events) {
    if (event.hash_prev !== previousHash) {
      return {
        events: events.length,
        ok: false,
        break: {
          kind: "hash_prev_mismatch",
          eventId: event.id,
          expected: previousHash,
          actual: event.hash_prev,
        },
      };
    }
    const expected = sha256(
      stableStringify({
        request_id: parsed.request?.id ?? null,
        event_type: event.event_type,
        payload_json: event.payload_json,
        created_at: event.created_at,
        hash_prev: event.hash_prev,
      }),
    );
    if (expected !== event.hash_self) {
      return {
        events: events.length,
        ok: false,
        break: {
          kind: "hash_self_mismatch",
          eventId: event.id,
          expected,
          actual: event.hash_self,
        },
      };
    }
    previousHash = event.hash_self;
  }
  return { events: events.length, ok: true, break: null };
}

export function verifyRequestReceiptBundle(
  bundleDir: string,
  options: VerifyReceiptOptions = {},
): ReceiptVerificationResult {
  const errors: string[] = [];
  const resolvedDir = path.resolve(bundleDir);
  const expectFp = options.expectFingerprintSha256 ? normalizeFingerprint(options.expectFingerprintSha256) : null;

  if (!existsSync(resolvedDir)) {
    return {
      ok: false,
      bundleDir: resolvedDir,
      manifestVerified: false,
      manifestSha256: "",
      signerSubject: null,
      signerFingerprintSha256: null,
      fingerprintPinned: expectFp ? false : null,
      trustNote: expectFp ? TRUST_NOTE_PINNED : TRUST_NOTE_UNPINNED,
      files: [],
      chain: null,
      errors: [`Bundle directory does not exist: ${resolvedDir}`],
    };
  }

  const manifestPath = path.join(resolvedDir, "manifest.json");
  const signaturePath = path.join(resolvedDir, "manifest.sig");
  const certPath = path.join(resolvedDir, "manifest.cert.pem");

  let manifestVerified = false;
  let manifestSha256 = "";
  let signerSubject: string | null = null;
  let signerFingerprintSha256: string | null = null;
  let manifest: Manifest = {};

  if (!existsSync(manifestPath) || !existsSync(signaturePath) || !existsSync(certPath)) {
    errors.push("Bundle is missing one or more of: manifest.json, manifest.sig, manifest.cert.pem.");
  } else {
    const manifestBytes = readFileSync(manifestPath);
    manifestSha256 = sha256(manifestBytes);
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
    } catch (error) {
      errors.push(`manifest.json is not valid JSON: ${(error as Error).message}`);
    }
    try {
      const cert = new X509Certificate(readFileSync(certPath, "utf8"));
      signerSubject = cert.subject;
      signerFingerprintSha256 = cert.fingerprint256 ?? null;
      const verify = createVerify("RSA-SHA256");
      verify.update(manifestBytes);
      manifestVerified = verify.verify(cert.publicKey, readFileSync(signaturePath));
      if (!manifestVerified) {
        errors.push("Signature does not verify against manifest.json with the embedded cert.");
      }
    } catch (error) {
      errors.push(`Cert/signature read failed: ${(error as Error).message}`);
    }
  }

  // Trust-anchor pinning (optional). Without it, a valid manifest signature
  // only proves the bundle is self-consistent — the embedded cert vouches for
  // itself. With --expect-fingerprint we require the embedded cert to match a
  // fingerprint the verifier already trusts.
  let fingerprintPinned: boolean | null = null;
  if (expectFp) {
    const actualFp = signerFingerprintSha256 ? normalizeFingerprint(signerFingerprintSha256) : null;
    fingerprintPinned = actualFp !== null && actualFp === expectFp;
    if (!fingerprintPinned) {
      errors.push(
        `Signer cert fingerprint ${actualFp ?? "(none)"} does not match --expect-fingerprint ${expectFp}.`,
      );
    }
  }

  const fileChecks = checkFiles(resolvedDir, manifest, errors);
  const chainCheck = checkAuditChain(resolvedDir, errors);

  for (const f of fileChecks) {
    if (!f.ok) errors.push(`File hash mismatch: ${f.name}`);
  }
  if (chainCheck && !chainCheck.ok) {
    errors.push(`Audit chain broken at event ${chainCheck.break?.eventId} (${chainCheck.break?.kind}).`);
  }

  return {
    ok: manifestVerified
      && fileChecks.every((f) => f.ok)
      && (chainCheck?.ok ?? false)
      && (fingerprintPinned !== false),
    bundleDir: resolvedDir,
    manifestVerified,
    manifestSha256,
    signerSubject,
    signerFingerprintSha256,
    fingerprintPinned,
    trustNote: fingerprintPinned === true ? TRUST_NOTE_PINNED : TRUST_NOTE_UNPINNED,
    files: fileChecks,
    chain: chainCheck,
    errors,
  };
}
