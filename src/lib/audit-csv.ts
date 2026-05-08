// CSV export for audit events. RFC 4180 quoting: any field containing ",", "\"",
// "\n" or "\r" gets wrapped in double-quotes, and inner double-quotes are
// escaped by doubling. CRLF line endings — the spec calls for them and most
// spreadsheet tools handle either, but a few legacy importers reject LF.

export type AuditCsvRow = {
  id: number;
  event_type: string;
  payload_json: string;
  hash_prev: string | null;
  hash_self: string;
  created_at: string;
};

const COLUMNS: ReadonlyArray<keyof AuditCsvRow> = [
  "id",
  "event_type",
  "created_at",
  "hash_prev",
  "hash_self",
  "payload_json",
];

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\r\n]/u.test(str)) {
    return `"${str.replace(/"/gu, '""')}"`;
  }
  return str;
}

export function renderAuditChainAsCsv(rows: ReadonlyArray<AuditCsvRow>): string {
  const header = COLUMNS.join(",");
  if (rows.length === 0) return header + "\r\n";
  const body = rows
    .map((row) => COLUMNS.map((col) => csvEscape(row[col])).join(","))
    .join("\r\n");
  return `${header}\r\n${body}\r\n`;
}
