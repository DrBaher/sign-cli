// Tiny USTAR writer. The compliance bundle is self-contained text/binary
// files; we don't need extended attributes, sparse files, or long names.
// USTAR's 512-byte header is enough.
//
// Format reference: POSIX 1003.1-1990 / IEEE Std 1003.1.
// Each header has these fields (offset/size in bytes):
//
//   0   100 name        — file path, NUL-terminated
//   100   8 mode        — octal, NUL-terminated (e.g. "0000644 ")
//   108   8 uid         — octal
//   116   8 gid         — octal
//   124  12 size        — octal byte count (0 for dirs)
//   136  12 mtime       — octal seconds since epoch
//   148   8 chksum      — octal sum of header bytes (chksum field treated as spaces)
//   156   1 typeflag    — '0' regular file, '5' directory
//   157 100 linkname    — empty for our use
//   257   6 magic       — "ustar\0"
//   263   2 version     — "00"
//   265  32 uname       — empty
//   297  32 gname       — empty
//   329   8 devmajor    — empty
//   337   8 devminor    — empty
//   345 155 prefix      — long-path prefix (we limit to 100 chars total)
//
// Files are followed by their data padded to 512-byte boundaries. The archive
// terminates with two consecutive 512-byte zero blocks.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeField(buffer: Buffer, offset: number, value: string, length: number): void {
  buffer.write(value, offset, length, "utf8");
}

function buildHeader(name: string, size: number, isDir: boolean, mtimeSeconds: number): Buffer {
  if (Buffer.byteLength(name, "utf8") > 100) {
    throw new Error(`USTAR path too long (max 100 bytes): ${name}`);
  }
  const buf = Buffer.alloc(512);
  writeField(buf, 0, name, 100);
  writeField(buf, 100, octal(isDir ? 0o755 : 0o644, 8), 8);
  writeField(buf, 108, octal(0, 8), 8);
  writeField(buf, 116, octal(0, 8), 8);
  writeField(buf, 124, octal(size, 12), 12);
  writeField(buf, 136, octal(mtimeSeconds, 12), 12);
  buf.fill(0x20, 148, 156); // chksum field starts as spaces
  writeField(buf, 156, isDir ? "5" : "0", 1);
  writeField(buf, 257, "ustar\0", 6);
  writeField(buf, 263, "00", 2);

  let chksum = 0;
  for (let i = 0; i < 512; i += 1) chksum += buf[i];
  writeField(buf, 148, octal(chksum, 8), 8);
  return buf;
}

export type TarEntry = { name: string; data: Buffer; isDir?: boolean; mtime?: Date };

// Build a USTAR archive (uncompressed) from in-memory entries. For very large
// archives this would benefit from a streaming writer — for our compliance
// bundles (handful of MB at most) buffering is fine and simpler.
export function buildTarArchive(entries: ReadonlyArray<TarEntry>, now: Date = new Date()): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.data;
    const mtimeSeconds = Math.floor((entry.mtime ?? now).getTime() / 1000);
    const header = buildHeader(entry.name, entry.isDir ? 0 : data.length, Boolean(entry.isDir), mtimeSeconds);
    blocks.push(header);
    if (!entry.isDir && data.length > 0) {
      blocks.push(data);
      const remainder = data.length % 512;
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
    }
  }
  // Terminator: two zero blocks.
  blocks.push(Buffer.alloc(512), Buffer.alloc(512));
  return Buffer.concat(blocks);
}

// Walk a directory and pack every file into a tar entry list relative to
// `rootName` (so the archive extracts into ./<rootName>/…).
export function tarEntriesFromDir(dir: string, rootName: string): TarEntry[] {
  const entries: TarEntry[] = [];
  function walk(absPath: string, relPath: string): void {
    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      // USTAR dir entries end with a trailing slash, conventionally.
      entries.push({ name: relPath.endsWith("/") ? relPath : `${relPath}/`, data: Buffer.alloc(0), isDir: true, mtime: stat.mtime });
      for (const child of readdirSync(absPath).sort()) {
        walk(path.join(absPath, child), `${relPath}/${child}`.replace(/\/+/g, "/"));
      }
    } else if (stat.isFile()) {
      entries.push({ name: relPath, data: readFileSync(absPath), mtime: stat.mtime });
    }
  }
  walk(dir, rootName);
  return entries;
}

// Convenience: build the gzipped tarball for a directory in one call.
export function buildTarGzFromDir(dir: string, rootName: string, now?: Date): Buffer {
  const archive = buildTarArchive(tarEntriesFromDir(dir, rootName), now);
  return zlib.gzipSync(archive);
}
