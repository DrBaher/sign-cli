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

// --- Static timeline renderer -----------------------------------------------
// Render a fixed snapshot of audit events as a multi-line timeline. Different
// from formatAuditLine + attachPrettyAuditPrinter which run live (subscribed
// to new events) — this one is the one-shot dump for `audit show --format
// pretty`.
//
// Output shape per event:
//
//   2026-05-08T12:00:00.000Z  [event_type]
//     hash: 1a2b…cdef  prev: aabb…1234
//     key=value  key=value  …          (top-level scalar payload fields)
//
// No shell colors — pipe through `bat` or `less -R` for highlighting.

export type PrettyAuditEvent = {
  id: number;
  event_type: string;
  payload_json: string;
  hash_prev: string | null;
  hash_self: string;
  created_at: string;
};

export function renderAuditChainAsPretty(events: ReadonlyArray<PrettyAuditEvent>): string {
  if (events.length === 0) return "(no events)";
  const lines: string[] = [];
  for (const event of events) {
    lines.push(`${event.created_at}  [${event.event_type}]`);
    lines.push(`  hash: ${shortHashStatic(event.hash_self)}  prev: ${event.hash_prev === null ? "(genesis)" : shortHashStatic(event.hash_prev)}`);
    const summary = summarizePayload(event.payload_json);
    if (summary) lines.push(`  ${summary}`);
  }
  return lines.join("\n");
}

function shortHashStatic(hex: string): string {
  if (hex.length <= 16) return hex;
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

function summarizePayload(payloadJson: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return abbreviate(payloadJson, 80);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return abbreviate(payloadJson, 80);
  }
  const obj = payload as Record<string, unknown>;
  const scalars: string[] = [];
  let hasNested = false;
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const rendered = typeof value === "string" ? `"${abbreviate(value, 40)}"` : String(value);
      scalars.push(`${key}=${rendered}`);
    } else {
      hasNested = true;
    }
  }
  let line = scalars.join("  ");
  if (hasNested) {
    line = line.length > 0 ? `${line}  …` : abbreviate(payloadJson, 80);
  }
  return line;
}

function abbreviate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
