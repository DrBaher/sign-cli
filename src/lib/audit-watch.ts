import type { SqliteDb } from "./db.js";
import { subscribeResource } from "./resource-watch.js";
import { scanAllAuditChains } from "./signing-service.js";
import type { AuditScanReport } from "./signing-service.js";

export type AuditWatchOptions = {
  // If unset, scan every request. If set, scan only this request_id.
  requestId?: string;
  // Belt-and-suspenders periodic scan even when no resource notifications fire.
  pollIntervalMs?: number;
  // Stop after N seconds. Unset = forever.
  timeoutMs?: number;
  onScan?: (report: AuditScanReport, trigger: "initial" | "notify" | "poll" | "final") => void;
  now?: () => Date;
};

export type AuditWatchOutcome = {
  exitReason: "break_detected" | "timeout" | "stopped";
  scans: number;
  initial: AuditScanReport;
  final: AuditScanReport;
  firstBreak: AuditScanReport["results"][number] | null;
  startedAt: string;
  elapsedMs: number;
};

export async function runAuditWatch(db: SqliteDb, opts: AuditWatchOptions = {}): Promise<AuditWatchOutcome> {
  const now = opts.now ?? (() => new Date());
  const startedAtMs = now().getTime();
  const startedAt = new Date(startedAtMs).toISOString();
  const pollIntervalMs = opts.pollIntervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs;

  const runScan = (): AuditScanReport => {
    if (opts.requestId) {
      // Manual one-shot scan over a single request_id by reusing scanAllAuditChains
      // with a synthetic filter: pull only the targeted request.
      const requestRow = db.prepare("SELECT id FROM requests WHERE id = ?").get(opts.requestId) as { id: string } | undefined;
      if (!requestRow) {
        return { total: 0, valid: 0, invalid: 0, results: [] };
      }
      // Cheaper than re-importing the verifier — just call the same fn with no filter and
      // then narrow.
      const full = scanAllAuditChains(db);
      const targeted = full.results.filter((r) => r.requestId === opts.requestId);
      return {
        total: targeted.length,
        valid: targeted.filter((r) => r.valid).length,
        invalid: targeted.filter((r) => !r.valid).length,
        results: targeted,
      };
    }
    return scanAllAuditChains(db);
  };

  const initial = runScan();
  let scans = 1;
  opts.onScan?.(initial, "initial");

  let stopped = false;
  let exitReason: AuditWatchOutcome["exitReason"] = "stopped";
  let firstBreak: AuditScanReport["results"][number] | null =
    initial.results.find((r) => !r.valid) ?? null;
  if (firstBreak) {
    return {
      exitReason: "break_detected",
      scans,
      initial,
      final: initial,
      firstBreak,
      startedAt,
      elapsedMs: now().getTime() - startedAtMs,
    };
  }

  let pendingScan = false;
  const unsubscribe = subscribeResource("*", () => {
    pendingScan = true;
  });

  let final = initial;
  try {
    while (!stopped) {
      if (typeof timeoutMs === "number" && timeoutMs >= 0) {
        const elapsed = now().getTime() - startedAtMs;
        if (elapsed >= timeoutMs) {
          exitReason = "timeout";
          break;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      const trigger: "notify" | "poll" = pendingScan ? "notify" : "poll";
      pendingScan = false;
      const report = runScan();
      scans += 1;
      final = report;
      opts.onScan?.(report, trigger);
      const broken = report.results.find((r) => !r.valid);
      if (broken) {
        firstBreak = broken;
        exitReason = "break_detected";
        stopped = true;
      }
    }
  } finally {
    unsubscribe();
  }

  opts.onScan?.(final, "final");
  return {
    exitReason,
    scans,
    initial,
    final,
    firstBreak,
    startedAt,
    elapsedMs: now().getTime() - startedAtMs,
  };
}
