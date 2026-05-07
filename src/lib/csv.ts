import { readFile } from "node:fs/promises";

export type CsvRow = Record<string, string>;

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else if (ch === '"' && current.length === 0) {
      inQuotes = true;
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

export function parseCsv(raw: string): CsvRow[] {
  const stripped = raw.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
  const lines = stripped.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0]).map((cell) => cell.trim());
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      row[header] = (values[index] ?? "").trim();
    });
    return row;
  });
}

export async function loadCsvFile(filePath: string): Promise<CsvRow[]> {
  const raw = await readFile(filePath, "utf8");
  return parseCsv(raw);
}
