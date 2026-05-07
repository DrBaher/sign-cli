import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { SqliteDb } from "./db.js";

export type DbBackupResult = {
  source: string;
  destination: string;
  bytes: number;
};

export function backupDatabase(db: SqliteDb, sourcePath: string, outPath: string): DbBackupResult {
  const dest = path.resolve(outPath);
  mkdirSync(path.dirname(dest), { recursive: true });
  const escaped = dest.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}';`);
  const stats = statSync(dest);
  return { source: path.resolve(sourcePath), destination: dest, bytes: stats.size };
}

export type DbVerifyResult = {
  ok: boolean;
  integrity: string[];
  foreignKeys: string[];
};

export function verifyDatabase(db: SqliteDb): DbVerifyResult {
  const integrityRows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
  const integrity = integrityRows.map((row) => String(row.integrity_check ?? row));
  const fkRows = db.prepare("PRAGMA foreign_key_check").all() as Array<Record<string, unknown>>;
  const foreignKeys = fkRows.map((row) => JSON.stringify(row));
  const ok = integrity.length === 1 && integrity[0] === "ok" && foreignKeys.length === 0;
  return { ok, integrity, foreignKeys };
}
