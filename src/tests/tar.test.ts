import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { buildTarArchive, buildTarGzFromDir, tarEntriesFromDir } from "../lib/tar.js";

test("buildTarArchive produces a USTAR archive that GNU tar can extract", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-tar-"));
  try {
    const archive = buildTarArchive([
      { name: "out", data: Buffer.alloc(0), isDir: true },
      { name: "out/hello.txt", data: Buffer.from("hello world\n", "utf8") },
      { name: "out/sub", data: Buffer.alloc(0), isDir: true },
      { name: "out/sub/inner.bin", data: Buffer.from([0x00, 0x01, 0x02, 0x03]) },
    ], new Date("2026-05-08T12:00:00Z"));
    const archivePath = path.join(dir, "out.tar");
    writeFileSync(archivePath, archive);
    // Ask the system tar to extract it. If that succeeds, our archive is
    // structurally valid USTAR.
    execFileSync("tar", ["-xf", archivePath], { cwd: dir });
    const helloText = readFileSync(path.join(dir, "out", "hello.txt"), "utf8");
    assert.equal(helloText, "hello world\n");
    const innerBytes = readFileSync(path.join(dir, "out", "sub", "inner.bin"));
    assert.deepEqual([...innerBytes], [0x00, 0x01, 0x02, 0x03]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTarGzFromDir round-trips a real on-disk tree through gzip + tar", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-tar-gz-"));
  const src = path.join(dir, "src");
  mkdirSync(path.join(src, "nested"), { recursive: true });
  writeFileSync(path.join(src, "top.txt"), "alpha");
  writeFileSync(path.join(src, "nested", "deep.txt"), "beta");
  try {
    const gz = buildTarGzFromDir(src, "src");
    // gzip header
    assert.equal(gz[0], 0x1f);
    assert.equal(gz[1], 0x8b);
    const tarBytes = zlib.gunzipSync(gz);
    // Smoke check: the inflated archive ends with two zero blocks.
    const trailer = tarBytes.subarray(tarBytes.length - 1024);
    assert.ok(trailer.every((b) => b === 0), "USTAR archive must end with two zero blocks");

    // Extract via system tar to confirm round-trip.
    const out = path.join(dir, "extract");
    mkdirSync(out, { recursive: true });
    const archivePath = path.join(dir, "src.tar.gz");
    writeFileSync(archivePath, gz);
    execFileSync("tar", ["-xzf", archivePath], { cwd: out });
    assert.equal(readFileSync(path.join(out, "src", "top.txt"), "utf8"), "alpha");
    assert.equal(readFileSync(path.join(out, "src", "nested", "deep.txt"), "utf8"), "beta");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tarEntriesFromDir yields entries in deterministic sorted order", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-tar-order-"));
  const src = path.join(dir, "src");
  mkdirSync(src);
  writeFileSync(path.join(src, "b.txt"), "b");
  writeFileSync(path.join(src, "a.txt"), "a");
  writeFileSync(path.join(src, "c.txt"), "c");
  try {
    const entries = tarEntriesFromDir(src, "src");
    const fileNames = entries.filter((e) => !e.isDir).map((e) => e.name);
    assert.deepEqual(fileNames, ["src/a.txt", "src/b.txt", "src/c.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
