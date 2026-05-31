// Cross-request audit anchoring. The existing `audit timestamp` issues a TSR
// over a single request's chain head — useful per-request, but doesn't help
// you prove that a 1000-row deployment has been continuously valid since
// last Tuesday.
//
// `audit anchor` snapshots EVERY request's chain head at this moment and
// timestamps a single digest over the whole set. One TSA call, one artifact,
// O(N) request_ids covered.
//
// The manifest is { requestId, hashSelf }[] sorted by requestId. The digest
// is sha256(stableStringify(manifest)) — sorted + canonical so re-running
// the anchor on the same DB state produces a byte-identical digest.

import type { SqliteDb } from "./db.js";
import { issueRfc3161Timestamp, inspectTimestampResponse, type TimestampInspection } from "./timestamp.js";
import { appendAuditEvent } from "./audit.js";
import { insertArtifactRow } from "./signing-service.js";
import { createId, nowIso, sha256, stableStringify } from "./util.js";

export type AnchorManifestEntry = {
  requestId: string;
  hashSelf: string;
};

export type AnchorReport = {
  tsaUrl: string;
  digestHex: string;
  manifest: AnchorManifestEntry[];
  manifestBytes: number;
  responseBytes: number;
  artifactPath: string;
  manifestPath: string;
  inspection: TimestampInspection;
};

export async function anchorAllAuditChainHeads(
  db: SqliteDb,
  input: { tsaUrl?: string; outDir?: string; now?: Date; since?: string; trustAnchors?: Array<string | Buffer> } = {},
): Promise<AnchorReport> {
  const path = await import("node:path");
  const fs = await import("node:fs");

  // For every request that has at least one audit event, take the latest
  // hash_self (the chain head). Sorting by requestId makes the digest
  // deterministic so re-anchoring identical state produces identical digests.
  // When `since` is set, restrict to chains whose latest event is at or after
  // that ISO timestamp — useful when you only want to anchor what's actually
  // moved since the last anchor (smaller manifest, cheaper to verify).
  if (input.since !== undefined && Number.isNaN(Date.parse(input.since))) {
    throw new Error(`anchor since must be an ISO 8601 timestamp; got ${JSON.stringify(input.since)}.`);
  }
  const sinceClause = input.since ? `WHERE datetime(created_at) >= datetime(?)` : "";
  const sinceParams = input.since ? [input.since] : [];
  const rows = db.prepare(
    `SELECT request_id, hash_self
     FROM (
       SELECT request_id, hash_self, created_at, ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY id DESC) AS rn
       FROM audit_events
       ${sinceClause}
     ) WHERE rn = 1
     ORDER BY request_id`,
  ).all(...sinceParams) as Array<{ request_id: string; hash_self: string }>;

  if (rows.length === 0) {
    throw new Error(input.since
      ? `No audit events at or after ${input.since} — nothing to anchor.`
      : "No audit events found across any request — nothing to anchor.");
  }

  const manifest: AnchorManifestEntry[] = rows.map((row) => ({
    requestId: row.request_id,
    hashSelf: row.hash_self,
  }));
  const manifestText = stableStringify(manifest);
  const manifestBytes = Buffer.byteLength(manifestText, "utf8");
  const digestHex = sha256(manifestText);
  const digest = Buffer.from(digestHex, "hex");

  const result = await issueRfc3161Timestamp({ digest, tsaUrl: input.tsaUrl });
  const inspection = inspectTimestampResponse(result.responseBuffer, digest, input.trustAnchors);

  const now = input.now ?? new Date();
  const stamp = nowIso(now).replace(/[:.]/g, "-");
  const outDir = path.resolve(input.outDir ?? "artifacts");
  fs.mkdirSync(outDir, { recursive: true });
  const artifactPath = path.join(outDir, `audit-anchor-${stamp}.tsr`);
  const manifestPath = path.join(outDir, `audit-anchor-${stamp}.manifest.json`);
  fs.writeFileSync(artifactPath, result.responseBuffer);
  fs.writeFileSync(manifestPath, manifestText);

  // Record once per request so each chain shows the anchoring in its own
  // audit log. Single artifact row per anchor (kind=audit_anchor) covers
  // the file-level reference; per-request audit_events provide the chain
  // continuity that re-verification keys off.
  insertArtifactRow(db, {
    id: createId("art"),
    requestId: manifest[0].requestId, // anchor is global; pin the artifact row to the lowest-id request
    kind: "audit_anchor",
    path: artifactPath,
    contentHash: sha256(result.responseBuffer),
    metadataJson: stableStringify({
      tsaUrl: result.tsaUrl,
      manifestPath,
      manifestBytes,
      digestHex,
      coveredRequests: manifest.length,
    }),
    createdAt: nowIso(now),
  });

  for (const entry of manifest) {
    appendAuditEvent(db, {
      requestId: entry.requestId,
      eventType: "audit.anchored",
      payload: {
        tsaUrl: result.tsaUrl,
        digestHex,
        manifestBytes,
        coveredRequests: manifest.length,
        granted: inspection.granted,
        cryptographicallyVerified: inspection.cryptographicallyVerified,
      },
      now,
    });
  }

  return {
    tsaUrl: result.tsaUrl,
    digestHex,
    manifest,
    manifestBytes,
    responseBytes: result.responseBuffer.length,
    artifactPath,
    manifestPath,
    inspection,
  };
}

// --- Anchor verification ----------------------------------------------------
// Read a previously-issued anchor (manifest.json) and re-check whether the
// chains it covered have shifted. Per-row outcome:
//
//   matches    — the request's current chain head equals what was anchored
//   shifted    — the chain has progressed (new events appended after the anchor)
//                — typical and expected; not necessarily tampering
//   tampered   — the chain head now exists at an EARLIER id than the anchored
//                row, or the anchored hash isn't present anywhere — strong
//                signal that history was rewritten
//   missing    — the requestId no longer exists at all
//
// The anchor's own digest is recomputed and surfaced too, so callers can
// match it against the .tsr's contained digest (the cryptographic seal).

export type AnchorVerifyOutcome = "matches" | "shifted" | "tampered" | "missing";

export type AnchorVerifyRow = {
  requestId: string;
  anchoredHashSelf: string;
  currentHashSelf: string | null;
  outcome: AnchorVerifyOutcome;
};

export type AnchorVerifyReport = {
  digestHex: string;        // recomputed from the loaded manifest
  total: number;
  matches: number;
  shifted: number;
  tampered: number;
  missing: number;
  results: AnchorVerifyRow[];
};

export function verifyAnchorManifest(
  db: SqliteDb,
  manifest: ReadonlyArray<AnchorManifestEntry>,
): AnchorVerifyReport {
  // Recompute the digest the same way anchorAllAuditChainHeads did, so
  // callers can compare it to the .tsr's contained digest.
  const sorted = [...manifest].sort((a, b) => a.requestId.localeCompare(b.requestId));
  const digestHex = sha256(stableStringify(sorted));

  const results: AnchorVerifyRow[] = [];
  let matches = 0;
  let shifted = 0;
  let tampered = 0;
  let missing = 0;

  for (const entry of sorted) {
    // Latest hash_self (current chain head) for the requestId.
    const headRow = db.prepare(
      `SELECT id, hash_self FROM audit_events WHERE request_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(entry.requestId) as { id: number; hash_self: string } | undefined;
    if (!headRow) {
      results.push({ requestId: entry.requestId, anchoredHashSelf: entry.hashSelf, currentHashSelf: null, outcome: "missing" });
      missing += 1;
      continue;
    }
    if (headRow.hash_self === entry.hashSelf) {
      results.push({ requestId: entry.requestId, anchoredHashSelf: entry.hashSelf, currentHashSelf: headRow.hash_self, outcome: "matches" });
      matches += 1;
      continue;
    }
    // Was the anchored hash ever present in this request's chain? If yes, the
    // chain has progressed past it (shifted). If no, history was rewritten —
    // tampered.
    const ancestor = db.prepare(
      `SELECT 1 FROM audit_events WHERE request_id = ? AND hash_self = ? LIMIT 1`,
    ).get(entry.requestId, entry.hashSelf);
    if (ancestor) {
      results.push({ requestId: entry.requestId, anchoredHashSelf: entry.hashSelf, currentHashSelf: headRow.hash_self, outcome: "shifted" });
      shifted += 1;
    } else {
      results.push({ requestId: entry.requestId, anchoredHashSelf: entry.hashSelf, currentHashSelf: headRow.hash_self, outcome: "tampered" });
      tampered += 1;
    }
  }

  return {
    digestHex,
    total: sorted.length,
    matches,
    shifted,
    tampered,
    missing,
    results,
  };
}

// --- Anchor enumeration -----------------------------------------------------
// Lists stored audit_anchor artifacts so an operator can pick which anchor
// to verify against (or just spot-check that anchors are still being issued
// on a cadence).
//
// Each artifact row carries the metadata_json blob anchorAllAuditChainHeads
// wrote, which already has tsaUrl + manifestPath + manifestBytes + digestHex
// + coveredRequests.

export type StoredAnchorEntry = {
  artifactId: string;
  artifactPath: string;
  manifestPath: string | null;
  digestHex: string | null;
  tsaUrl: string | null;
  coveredRequests: number | null;
  manifestBytes: number | null;
  contentHash: string;
  createdAt: string;
};

export function listStoredAnchors(db: SqliteDb, opts: { limit?: number } = {}): StoredAnchorEntry[] {
  const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) > 0 ? Math.min(Number(opts.limit), 1000) : 100;
  // ORDER BY created_at falls back to rowid for stable tie-breaking when
  // two anchors land in the same second (created_at has second resolution;
  // rowid is monotonic).
  const rows = db.prepare(
    `SELECT id, path, content_hash, metadata_json, created_at
     FROM artifacts
     WHERE kind = 'audit_anchor'
     ORDER BY datetime(created_at) DESC, rowid DESC
     LIMIT ${limit}`,
  ).all() as Array<{ id: string; path: string; content_hash: string; metadata_json: string; created_at: string }>;
  return rows.map((row) => {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(row.metadata_json); } catch { /* tolerate malformed metadata */ }
    return {
      artifactId: row.id,
      artifactPath: row.path,
      manifestPath: typeof meta.manifestPath === "string" ? meta.manifestPath : null,
      digestHex: typeof meta.digestHex === "string" ? meta.digestHex : null,
      tsaUrl: typeof meta.tsaUrl === "string" ? meta.tsaUrl : null,
      coveredRequests: typeof meta.coveredRequests === "number" ? meta.coveredRequests : null,
      manifestBytes: typeof meta.manifestBytes === "number" ? meta.manifestBytes : null,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    };
  });
}

// Dry-run preview: same manifest + digest computation as the real anchor,
// but no TSA call, no on-disk artifact, no audit_events appended. Lets an
// operator check what `audit anchor` *would* produce — manifest size,
// digest, covered request count — before burning a TSA round-trip.
export type AnchorDryRunReport = {
  digestHex: string;
  manifest: AnchorManifestEntry[];
  manifestBytes: number;
  // Echoes back the cutoff so the caller can confirm `--since` was honored.
  since: string | null;
};

export function previewAnchorAllAuditChainHeads(
  db: SqliteDb,
  input: { since?: string } = {},
): AnchorDryRunReport {
  if (input.since !== undefined && Number.isNaN(Date.parse(input.since))) {
    throw new Error(`anchor since must be an ISO 8601 timestamp; got ${JSON.stringify(input.since)}.`);
  }
  const sinceClause = input.since ? `WHERE datetime(created_at) >= datetime(?)` : "";
  const sinceParams = input.since ? [input.since] : [];
  const rows = db.prepare(
    `SELECT request_id, hash_self
     FROM (
       SELECT request_id, hash_self, created_at, ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY id DESC) AS rn
       FROM audit_events
       ${sinceClause}
     ) WHERE rn = 1
     ORDER BY request_id`,
  ).all(...sinceParams) as Array<{ request_id: string; hash_self: string }>;
  if (rows.length === 0) {
    throw new Error(input.since
      ? `No audit events at or after ${input.since} — nothing to anchor.`
      : "No audit events found across any request — nothing to anchor.");
  }
  const manifest: AnchorManifestEntry[] = rows.map((row) => ({
    requestId: row.request_id,
    hashSelf: row.hash_self,
  }));
  const manifestText = stableStringify(manifest);
  return {
    digestHex: sha256(manifestText),
    manifest,
    manifestBytes: Buffer.byteLength(manifestText, "utf8"),
    since: input.since ?? null,
  };
}
