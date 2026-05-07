import type { SqliteDb } from "./db.js";
import { subscribeResource } from "./resource-watch.js";

type AuditRow = {
  id: number;
  event_type: string;
  payload_json: string;
  hash_self: string;
  created_at: string;
};

export function formatAuditLine(row: AuditRow, requestId: string): string {
  const time = row.created_at.replace("T", " ").replace(/\.\d+Z$/, "Z");
  let summary = "";
  try {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["signerEmail", "providerStatus", "decision", "reason", "verified", "replayed"]) {
      const value = payload[key];
      if (value === undefined) continue;
      if (typeof value === "object" && value !== null) {
        if (key === "decision") {
          const action = (value as { action?: unknown }).action;
          if (typeof action === "string") parts.push(`action=${action}`);
        }
        continue;
      }
      parts.push(`${key}=${String(value)}`);
    }
    if (parts.length > 0) summary = ` ${parts.join(" ")}`;
  } catch {
    // ignore — the line still prints a usable summary
  }
  return `[${time}] ${requestId} ${row.event_type}${summary} #${row.hash_self.slice(0, 8)}`;
}

// Subscribes to all resource changes and pretty-prints each new audit event
// for the affected request to `output`. Returns a cleanup fn that detaches.
// Dedupes the parallel request:// and request://<id>/audit notifications by
// keying on (requestId, audit row id) and only printing once per row.
export function attachPrettyAuditPrinter(
  db: SqliteDb,
  output: NodeJS.WritableStream,
): () => void {
  const printed = new Set<number>();
  const unsubscribe = subscribeResource("*", (uri) => {
    const match = uri.match(/^request:\/\/([^/]+)/u);
    if (!match) return;
    const requestId = match[1];
    const row = db.prepare(
      "SELECT id, event_type, payload_json, hash_self, created_at FROM audit_events WHERE request_id = ? ORDER BY id DESC LIMIT 1",
    ).get(requestId) as AuditRow | undefined;
    if (!row) return;
    if (printed.has(row.id)) return;
    printed.add(row.id);
    output.write(`${formatAuditLine(row, requestId)}\n`);
  });
  return unsubscribe;
}
