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
  input: { tsaUrl?: string; outDir?: string; now?: Date } = {},
): Promise<AnchorReport> {
  const path = await import("node:path");
  const fs = await import("node:fs");

  // For every request that has at least one audit event, take the latest
  // hash_self (the chain head). Sorting by requestId makes the digest
  // deterministic so re-anchoring identical state produces identical digests.
  const rows = db.prepare(
    `SELECT request_id, hash_self
     FROM (
       SELECT request_id, hash_self, ROW_NUMBER() OVER (PARTITION BY request_id ORDER BY id DESC) AS rn
       FROM audit_events
     ) WHERE rn = 1
     ORDER BY request_id`,
  ).all() as Array<{ request_id: string; hash_self: string }>;

  if (rows.length === 0) {
    throw new Error("No audit events found across any request — nothing to anchor.");
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
  const inspection = inspectTimestampResponse(result.responseBuffer, digest);

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
  db.prepare(
    `INSERT INTO artifacts (id, request_id, kind, path, content_hash, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    createId("art"),
    manifest[0].requestId, // anchor is global; we attach the artifact row to the lowest-id request as a stable home
    "audit_anchor",
    artifactPath,
    sha256(result.responseBuffer),
    stableStringify({
      tsaUrl: result.tsaUrl,
      manifestPath,
      manifestBytes,
      digestHex,
      coveredRequests: manifest.length,
    }),
    nowIso(now),
  );

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
