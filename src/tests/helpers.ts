import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db.js";

export function makeTempDb(): { dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sign-cli-test-"));
  return {
    dbPath: path.join(tempDir, "sign.db"),
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

export function createDocumentFixture(contents = "sample contract"): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sign-doc-test-"));
  const filePath = path.join(tempDir, "document.txt");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

export function createDb(dbPath: string) {
  return openDatabase(dbPath);
}
