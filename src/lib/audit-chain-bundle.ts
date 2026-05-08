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
import { buildTarGzFromDir } from "./tar.js";

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
  // Set when the caller passed tarballPath. The .tar.gz is produced from the
  // assembled directory after INDEX.json is written, so the archive is a
  // faithful copy of what's on disk.
  tarballPath?: string;
  tarballBytes?: number;
};

export async function exportAuditChainBundle(
  db: SqliteDb,
  input: {
    outDir: string;
    requestIds?: string[];           // optional: which requests to include (default: every request that has audit events)
    now?: Date;
    // When set, also produce a gzipped tarball at this path. The archive's
    // top-level directory matches basename(outDir), so `tar xzf …` recreates
    // the same on-disk layout the bundle assembled.
    tarballPath?: string;
    // When true, also copy the unsigned source PDF (requests.document_path)
    // into each per-request receipt dir as `source.pdf`. Useful for
    // reproducibility — auditors can re-hash the source and confirm it
    // matches requests.document_hash without needing access to the issuing
    // system.
    includeSourcePdf?: boolean;
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
    if (input.includeSourcePdf) {
      // Pull document_path from the requests table and copy as source.pdf.
      // Skipped silently if the source file is gone (the receipt + audit chain
      // are still self-verifying without it).
      const row = db.prepare("SELECT document_path FROM requests WHERE id = ?")
        .get(requestId) as { document_path: string | null } | undefined;
      if (row?.document_path && fs.existsSync(row.document_path)) {
        fs.copyFileSync(row.document_path, path.join(receiptDir, "source.pdf"));
      }
    }
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

  const report: ChainBundleReport = { outDir, indexPath, anchor, requests: entries, totalBytes };

  if (input.tarballPath) {
    const gz = buildTarGzFromDir(outDir, path.basename(outDir));
    const resolvedTarball = path.resolve(input.tarballPath);
    fs.mkdirSync(path.dirname(resolvedTarball), { recursive: true });
    fs.writeFileSync(resolvedTarball, gz);
    report.tarballPath = resolvedTarball;
    report.tarballBytes = gz.length;
  }

  return report;
}

// --- Bundle verification ----------------------------------------------------
// Re-check a previously-issued chain bundle in one shot. Walks every
// requests/<id>/ subdir through verifyRequestReceiptBundle, re-hashes the
// anchor manifest and matches against INDEX.json's recorded digest, and
// confirms expected files exist.
//
// No DB needed. The bundle is supposed to be self-contained — verifying it
// shouldn't require the issuing system to still exist.

import { verifyRequestReceiptBundle } from "./receipt-verify.js";
import { extractTarToDir } from "./tar.js";
import { sha256, stableStringify } from "./util.js";

export type BundleVerifyRow = {
  requestId: string;
  ok: boolean;
  receiptDir: string;
  errors: string[];
};

export type BundleVerifyReport = {
  ok: boolean;
  bundleDir: string;
  indexPath: string;
  anchor:
    | { present: false }
    | { present: true; tsrPath: string; manifestPath: string; recordedDigest: string | null; recomputedDigest: string; matches: boolean };
  total: number;
  passed: number;
  failed: number;
  results: BundleVerifyRow[];
  errors: string[];          // top-level structural errors (missing INDEX.json, malformed JSON, etc.)
};

export async function verifyAuditChainBundle(bundleDir: string): Promise<BundleVerifyReport> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(bundleDir);
  const errors: string[] = [];

  const indexPath = path.join(root, "INDEX.json");
  if (!fs.existsSync(indexPath)) {
    return {
      ok: false, bundleDir: root, indexPath,
      anchor: { present: false },
      total: 0, passed: 0, failed: 0, results: [],
      errors: [`INDEX.json missing at ${indexPath}`],
    };
  }

  let index: { anchor?: { manifestPath?: string; tsrPath?: string; digestHex?: string }; requests?: Array<{ requestId?: string; receiptDir?: string }> };
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch (error) {
    return {
      ok: false, bundleDir: root, indexPath,
      anchor: { present: false },
      total: 0, passed: 0, failed: 0, results: [],
      errors: [`INDEX.json is not valid JSON: ${(error as Error).message}`],
    };
  }

  // Anchor check (if present): re-hash the manifest, compare to recordedDigest.
  let anchor: BundleVerifyReport["anchor"] = { present: false };
  if (index.anchor && typeof index.anchor.manifestPath === "string") {
    const manifestRel = index.anchor.manifestPath;
    // INDEX.json carries an absolute path written at bundle time; the file
    // may have moved. Fall back to looking for it under anchor/ if the
    // recorded path doesn't exist.
    let manifestPath = manifestRel;
    if (!fs.existsSync(manifestPath)) {
      const anchorDir = path.join(root, "anchor");
      if (fs.existsSync(anchorDir)) {
        const candidate = fs.readdirSync(anchorDir).find((n) => n.endsWith(".manifest.json"));
        if (candidate) manifestPath = path.join(anchorDir, candidate);
      }
    }
    if (!fs.existsSync(manifestPath)) {
      errors.push(`anchor manifest missing at ${manifestRel} (and no .manifest.json in ./anchor/)`);
      anchor = { present: true, tsrPath: index.anchor.tsrPath ?? "", manifestPath: manifestRel, recordedDigest: index.anchor.digestHex ?? null, recomputedDigest: "", matches: false };
    } else {
      let manifest: Array<{ requestId: string; hashSelf: string }>;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (error) {
        errors.push(`anchor manifest at ${manifestPath} is not JSON: ${(error as Error).message}`);
        manifest = [];
      }
      const sorted = [...manifest].sort((a, b) => a.requestId.localeCompare(b.requestId));
      const recomputed = sha256(stableStringify(sorted));
      const recorded = index.anchor.digestHex ?? null;
      anchor = {
        present: true,
        tsrPath: index.anchor.tsrPath ?? "",
        manifestPath,
        recordedDigest: recorded,
        recomputedDigest: recomputed,
        matches: recorded === recomputed,
      };
      if (!anchor.matches) errors.push(`anchor digest mismatch: INDEX.json=${recorded}, recomputed=${recomputed}`);
    }
  }

  // Per-request receipt checks.
  const requests = Array.isArray(index.requests) ? index.requests : [];
  const requestsRoot = path.join(root, "requests");
  const results: BundleVerifyRow[] = [];
  let passed = 0;
  let failed = 0;
  for (const entry of requests) {
    const requestId = String(entry.requestId ?? "");
    if (!requestId) continue;
    // Prefer the relative receiptDir stored in INDEX (path.relative output)
    // over any absolute path the bundle may have once recorded.
    const relDir = entry.receiptDir ?? path.join("requests", requestId);
    const receiptDir = path.isAbsolute(relDir) ? relDir : path.join(root, relDir);
    if (!fs.existsSync(receiptDir)) {
      results.push({ requestId, ok: false, receiptDir, errors: [`receipt directory missing: ${receiptDir}`] });
      failed += 1;
      continue;
    }
    const verdict = verifyRequestReceiptBundle(receiptDir);
    const rowOk = verdict.ok === true;
    results.push({
      requestId,
      ok: rowOk,
      receiptDir,
      errors: rowOk ? [] : (verdict.errors ?? [(verdict as { reason?: string }).reason ?? "verification failed"]),
    });
    if (rowOk) passed += 1; else failed += 1;
    void requestsRoot;
  }

  const ok = failed === 0 && errors.length === 0 && (anchor.present === false || anchor.matches);
  return {
    ok, bundleDir: root, indexPath,
    anchor,
    total: results.length,
    passed,
    failed,
    results,
    errors,
  };
}

// Tarball-aware front door. Accepts either:
//   { bundleDir }  — directory bundle (delegates to verifyAuditChainBundle)
//   { tarball }    — .tar.gz produced by `audit chain-bundle --tarball`;
//                    extracted to a temp directory, then verified, then
//                    cleaned up (preserves nothing on disk).
//
// Detects the on-disk top-level directory inside the archive (basename of
// the bundle when it was produced) and verifies that nested directory
// directly. Refuses to extract outside the temp dir (path-traversal guard
// already lives in extractTarToDir).
export async function verifyAuditChainBundleFromTarball(tarballPath: string): Promise<BundleVerifyReport> {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sign-verify-tarball-"));
  try {
    try {
      const raw = fs.readFileSync(tarballPath);
      const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
      const tarBytes = isGzip ? (await import("node:zlib")).gunzipSync(raw) : raw;
      extractTarToDir(tarBytes, tempRoot);
    } catch (error) {
      return {
        ok: false, bundleDir: tempRoot, indexPath: path.join(tempRoot, "INDEX.json"),
        anchor: { present: false }, total: 0, passed: 0, failed: 0, results: [],
        errors: [`failed to read tarball at ${tarballPath}: ${(error as Error).message}`],
      };
    }
    // Look for the on-disk root: either INDEX.json sits at the temp root
    // (rare — happens if the archive was produced with rootName === "."), or
    // it's one level deep (the typical "bundle/INDEX.json" layout).
    let bundleDir = tempRoot;
    if (!fs.existsSync(path.join(tempRoot, "INDEX.json"))) {
      const inner = fs.readdirSync(tempRoot);
      if (inner.length === 1 && fs.statSync(path.join(tempRoot, inner[0])).isDirectory()) {
        bundleDir = path.join(tempRoot, inner[0]);
      }
    }
    return await verifyAuditChainBundle(bundleDir);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
