import type { SqliteDb } from "./db.js";
import { SIGN_CLI_VERSION } from "./help-catalog.js";

// Aggregate counters across the whole DB, formatted as Prometheus text-format
// metrics. No external dep — Prometheus's exposition format is just plain text:
//   # HELP <name> <description>
//   # TYPE <name> counter|gauge
//   <name>{labels} <value>

function escapeLabel(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");
}

type LabelMap = Record<string, string>;

function formatMetric(name: string, labels: LabelMap, value: number): string {
  const parts = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",");
  return `${name}${parts ? `{${parts}}` : ""} ${value}`;
}

export function renderPrometheusMetrics(db: SqliteDb): string {
  const lines: string[] = [];

  // Total requests by status × provider
  lines.push("# HELP sign_cli_requests_total Number of requests grouped by provider and status.");
  lines.push("# TYPE sign_cli_requests_total gauge");
  const requestRows = db.prepare(
    "SELECT provider, status, COUNT(*) AS n FROM requests GROUP BY provider, status",
  ).all() as Array<{ provider: string | null; status: string; n: number }>;
  for (const row of requestRows) {
    lines.push(
      formatMetric("sign_cli_requests_total", { provider: row.provider ?? "unknown", status: row.status }, row.n),
    );
  }

  // Total audit events
  const auditTotal = db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number };
  lines.push("# HELP sign_cli_audit_events_total Number of audit-chain events ever appended.");
  lines.push("# TYPE sign_cli_audit_events_total counter");
  lines.push(formatMetric("sign_cli_audit_events_total", {}, auditTotal.n));

  // Audit events by event_type
  lines.push("# HELP sign_cli_audit_events_by_type Audit events grouped by event_type.");
  lines.push("# TYPE sign_cli_audit_events_by_type counter");
  const eventRows = db.prepare(
    "SELECT event_type, COUNT(*) AS n FROM audit_events GROUP BY event_type",
  ).all() as Array<{ event_type: string; n: number }>;
  for (const row of eventRows) {
    lines.push(formatMetric("sign_cli_audit_events_by_type", { event_type: row.event_type }, row.n));
  }

  // Signer signing states by source × signed/declined
  lines.push("# HELP sign_cli_signer_actions_total Signing/declining actions by signer source.");
  lines.push("# TYPE sign_cli_signer_actions_total counter");
  const stateRows = db.prepare(
    `SELECT source,
            SUM(CASE WHEN signed_at IS NOT NULL THEN 1 ELSE 0 END) AS signed_count,
            SUM(CASE WHEN declined_at IS NOT NULL THEN 1 ELSE 0 END) AS declined_count
     FROM signer_signing_states GROUP BY source`,
  ).all() as Array<{ source: string; signed_count: number; declined_count: number }>;
  for (const row of stateRows) {
    lines.push(formatMetric("sign_cli_signer_actions_total", { source: row.source, action: "signed" }, row.signed_count ?? 0));
    lines.push(formatMetric("sign_cli_signer_actions_total", { source: row.source, action: "declined" }, row.declined_count ?? 0));
  }

  // Webhook dedupe entries
  const webhookRows = db.prepare(
    "SELECT provider, COUNT(*) AS n FROM webhook_dedupe GROUP BY provider",
  ).all() as Array<{ provider: string; n: number }>;
  if (webhookRows.length > 0) {
    lines.push("# HELP sign_cli_webhook_dedupe_total Distinct verified webhook events seen, grouped by provider.");
    lines.push("# TYPE sign_cli_webhook_dedupe_total counter");
    for (const row of webhookRows) {
      lines.push(formatMetric("sign_cli_webhook_dedupe_total", { provider: row.provider }, row.n));
    }
  }

  lines.push("# HELP sign_cli_build_info Build info; value always 1, version label carries SIGN_CLI_VERSION.");
  lines.push("# TYPE sign_cli_build_info gauge");
  lines.push(formatMetric("sign_cli_build_info", { version: SIGN_CLI_VERSION }, 1));

  return `${lines.join("\n")}\n`;
}
