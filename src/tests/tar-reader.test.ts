import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTarArchive,
  buildTarGzFromDir,
  extractTarToDir,
  readTarArchive,
  readTarGzArchive,
} from "../lib/tar.js";
import {
  exportAuditChainBundle,
  verifyAuditChainBundleFromTarball,
} from "../lib/audit-chain-bundle.js";
import { anchorAllAuditChainHeads } from "../lib/audit-anchor.js";
import { createSigningRequest } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("readTarArchive round-trips files written by buildTarArchive (single source of truth)", () => {
  const archive = buildTarArchive([
    { name: "out", data: Buffer.alloc(0), isDir: true },
    { name: "out/a.txt", data: Buffer.from("alpha", "utf8") },
    { name: "out/b.bin", data: Buffer.from([0xff, 0x00, 0xa0]) },
  ], new Date("2026-05-08T00:00:00Z"));
  const entries = readTarArchive(archive);
  // Filter to files (the dir entry is also present).
  const files = entries.filter((e) => !e.isDir);
  assert.equal(files.length, 2);
  const a = files.find((f) => f.name === "out/a.txt")!;
  assert.equal(a.data.toString("utf8"), "alpha");
  const b = files.find((f) => f.name === "out/b.bin")!;
  assert.deepEqual([...b.data], [0xff, 0x00, 0xa0]);
});

test("extractTarToDir writes files back to disk and refuses path-traversal entries", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-tar-extract-"));
  try {
    const archive = buildTarArchive([
      { name: "out/safe.txt", data: Buffer.from("ok", "utf8") },
    ]);
    const written = extractTarToDir(archive, dir);
    assert.equal(written.length, 1);
    assert.equal(readFileSync(path.join(dir, "out", "safe.txt"), "utf8"), "ok");

    // Crafted entry that would escape outDir → throws before any write.
    const evil = buildTarArchive([
      { name: "../escape.txt", data: Buffer.from("nope", "utf8") },
    ]);
    assert.throws(() => extractTarToDir(evil, dir), /Refusing to extract outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTarGzArchive transparently decompresses gzipped USTAR streams", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-tar-gz-read-"));
  const src = path.join(dir, "src");
  mkdirSync(src);
  writeFileSync(path.join(src, "file.txt"), "hello");
  try {
    const gz = buildTarGzFromDir(src, "src");
    const entries = readTarGzArchive(gz);
    const file = entries.find((e) => e.name === "src/file.txt");
    assert.ok(file);
    assert.equal(file!.data.toString("utf8"), "hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withMockTsa(fn: (url: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/timestamp-reply");
      res.end(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    await fn(`http://127.0.0.1:${port}/tsa`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("verifyAuditChainBundleFromTarball extracts a .tar.gz produced by chain-bundle --tarball and verifies in-process", async () => {
  await withMockTsa(async (tsaUrl) => {
    const { dbPath, cleanup } = makeTempDb();
    const db = createDb(dbPath);
    const documentPath = createDocumentFixture("verify-tarball");
    const dir = mkdtempSync(path.join(os.tmpdir(), "sign-verify-tarball-flow-"));
    try {
      createSigningRequest(db, {
        title: "Tarball verify", documentPath,
        signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
        tokenTtlMinutes: 30, provider: "dropbox",
      });
      await anchorAllAuditChainHeads(db, { tsaUrl, outDir: dir });
      const out = path.join(dir, "bundle");
      const tarballPath = path.join(dir, "bundle.tar.gz");
      await exportAuditChainBundle(db, { outDir: out, tarballPath });
      const report = await verifyAuditChainBundleFromTarball(tarballPath);
      assert.equal(report.ok, true);
      assert.equal(report.passed, 1);
      if (report.anchor.present) assert.equal(report.anchor.matches, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      db.close();
      cleanup();
    }
  });
});

test("verifyAuditChainBundleFromTarball returns ok:false with a clear error when the tarball is missing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-verify-missing-"));
  try {
    const report = await verifyAuditChainBundleFromTarball(path.join(dir, "does-not-exist.tar.gz"));
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => /failed to read tarball/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

