// Compliance-grade chain bundle: one directory containing
//
//   INDEX.json                    — top-level manifest (what's inside, byte counts)
//   anchor/<filename>.tsr         — most recent audit-anchor TSR (if any)
//   anchor/<filename>.manifest.json — its manifest
//   requests/<requestId>/…        — per-request receipt-bundles (manifest.json,
//                                     audit.json, signed.pdf, manifest.sig,
//                                     manifest.cert.pem)
//
// One on-disk shape, fully self-contained. Operators can re-verify offline:
// load the anchor manifest, hash it, compare to the .tsr's contained digest;
// for each request, run verifyRequestReceiptBundle on the receipt dir.
//
// Wraps tarballing into a directory, deliberately. `tar czf bundle.tar.gz
// ./bundle/` is one extra command, and a directory is easier to spot-check
// (auditors can grep / vim individual files without `tar tf`-ing).

import type { SqliteDb } from "./db.js";
import { exportRequestReceipt } from "./signing-service.js";
import { listStoredAnchors } from "./audit-anchor.js";

export type ChainBundleEntry = {
  requestId: string;
  receiptDir: string;
  bytes: number;
  files: number;
};

export type ChainBundleReport = {
  outDir: string;
  indexPath: string;
  anchor: { tsrPath: string; manifestPath: string; digestHex: string | null } | null;
  requests: ChainBundleEntry[];
  totalBytes: number;
};

export async function exportAuditChainBundle(
  db: SqliteDb,
  input: {
    outDir: string;
    requestIds?: string[];           // optional: which requests to include (default: every request that has audit events)
    now?: Date;
  },
): Promise<ChainBundleReport> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const outDir = path.resolve(input.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  // 1. Most recent anchor (if any).
  const anchorsDir = path.join(outDir, "anchor");
  let anchor: ChainBundleReport["anchor"] = null;
  const anchors = listStoredAnchors(db, { limit: 1 });
  if (anchors[0]) {
    const a = anchors[0];
    fs.mkdirSync(anchorsDir, { recursive: true });
    const tsrCopy = path.join(anchorsDir, path.basename(a.artifactPath));
    if (fs.existsSync(a.artifactPath)) fs.copyFileSync(a.artifactPath, tsrCopy);
    let manifestCopy = "";
    if (a.manifestPath && fs.existsSync(a.manifestPath)) {
      manifestCopy = path.join(anchorsDir, path.basename(a.manifestPath));
      fs.copyFileSync(a.manifestPath, manifestCopy);
    }
    anchor = { tsrPath: tsrCopy, manifestPath: manifestCopy, digestHex: a.digestHex };
  }

  // 2. Per-request receipt bundles. Either the explicit list or every
  // request that has audit events (so empty / placeholder rows are skipped).
  const requestIds = input.requestIds ?? (db.prepare(
    `SELECT DISTINCT request_id FROM audit_events ORDER BY request_id`,
  ).all() as Array<{ request_id: string }>).map((row) => row.request_id);

  const requestsRoot = path.join(outDir, "requests");
  if (requestIds.length > 0) fs.mkdirSync(requestsRoot, { recursive: true });
  const entries: ChainBundleEntry[] = [];
  for (const requestId of requestIds) {
    const receiptDir = path.join(requestsRoot, requestId);
    await exportRequestReceipt(db, { requestId, outDir: receiptDir, now: input.now });
    let bytes = 0;
    let files = 0;
    for (const name of fs.readdirSync(receiptDir)) {
      const stat = fs.statSync(path.join(receiptDir, name));
      if (stat.isFile()) {
        bytes += stat.size;
        files += 1;
      }
    }
    entries.push({ requestId, receiptDir, bytes, files });
  }

  // 3. INDEX.json — the top-level seal.
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const indexPath = path.join(outDir, "INDEX.json");
  fs.writeFileSync(indexPath, JSON.stringify({
    version: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    anchor,
    requests: entries.map((e) => ({
      requestId: e.requestId,
      receiptDir: path.relative(outDir, e.receiptDir),
      bytes: e.bytes,
      files: e.files,
    })),
    totalBytes,
  }, null, 2));

  return { outDir, indexPath, anchor, requests: entries, totalBytes };
}
