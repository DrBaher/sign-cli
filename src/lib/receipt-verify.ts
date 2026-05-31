import { createVerify, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { sha256, stableStringify } from "./util.js";
import { computeChainHash } from "./audit.js";
import { resolveAuditHmacKey, HASH_ALGO_HMAC } from "./audit-key.js";

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
  files: ReceiptFileCheck[];
  chain: ReceiptChainCheck | null;
  errors: string[];
};

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
  hash_algo?: string | null;
  created_at: string;
};

type AuditPayload = {
  events?: AuditEvent[];
  request?: { id?: string };
};

function checkFiles(bundleDir: string, manifest: Manifest, errors: string[]): ReceiptFileCheck[] {
  if (!Array.isArray(manifest.files)) {
    errors.push("manifest.json has no files[] array.");
    return [];
  }
  const checks: ReceiptFileCheck[] = [];
  for (const entry of manifest.files) {
    const filePath = path.join(bundleDir, entry.name);
    if (!existsSync(filePath)) {
      checks.push({ name: entry.name, expected: entry.sha256, actual: "", ok: false });
      errors.push(`Bundle file missing: ${entry.name}`);
      continue;
    }
    const actual = sha256(readFileSync(filePath));
    checks.push({ name: entry.name, expected: entry.sha256, actual, ok: actual === entry.sha256 });
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
  const key = resolveAuditHmacKey();
  let previousHash: string | null = null;
  let seenKeyed = false;
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
    const rowKeyed = event.hash_algo === HASH_ALGO_HMAC;
    // Downgrade protection mirrors verifyChainRows: no legacy row after a
    // keyed one, and a keyed row can't be verified without the key.
    if ((seenKeyed && !rowKeyed) || (rowKeyed && key === null)) {
      return {
        events: events.length,
        ok: false,
        break: { kind: "hash_self_mismatch", eventId: event.id, expected: rowKeyed ? "(key required)" : "(keyed)", actual: event.hash_self },
      };
    }
    if (rowKeyed) seenKeyed = true;
    const expected = computeChainHash(
      {
        request_id: parsed.request?.id ?? null as unknown as string,
        event_type: event.event_type,
        payload_json: event.payload_json,
        created_at: event.created_at,
        hash_prev: event.hash_prev,
      },
      rowKeyed ? key : null,
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

export function verifyRequestReceiptBundle(bundleDir: string): ReceiptVerificationResult {
  const errors: string[] = [];
  const resolvedDir = path.resolve(bundleDir);

  if (!existsSync(resolvedDir)) {
    return {
      ok: false,
      bundleDir: resolvedDir,
      manifestVerified: false,
      manifestSha256: "",
      signerSubject: null,
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

  const fileChecks = checkFiles(resolvedDir, manifest, errors);
  const chainCheck = checkAuditChain(resolvedDir, errors);

  for (const f of fileChecks) {
    if (!f.ok) errors.push(`File hash mismatch: ${f.name}`);
  }
  if (chainCheck && !chainCheck.ok) {
    errors.push(`Audit chain broken at event ${chainCheck.break?.eventId} (${chainCheck.break?.kind}).`);
  }

  return {
    ok: manifestVerified && fileChecks.every((f) => f.ok) && (chainCheck?.ok ?? false),
    bundleDir: resolvedDir,
    manifestVerified,
    manifestSha256,
    signerSubject,
    files: fileChecks,
    chain: chainCheck,
    errors,
  };
}
