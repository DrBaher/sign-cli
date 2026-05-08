// Long-running pusher: render Prometheus text from the local DB and POST it
// to a remote endpoint on a cadence. The default cadence (30s) matches a
// typical scrape interval — picking a remote endpoint that just appends to a
// log or forwards to Prometheus pushgateway is the expected use case.
//
// Errors are logged to the progress callback but do NOT crash the loop —
// transient remote outages should not stop local DB ingest. Two consecutive
// hard errors slow the cadence down (gentle backoff) so we don't hammer a
// broken endpoint.

import type { SqliteDb } from "./db.js";
import { renderPrometheusMetrics } from "./prom-metrics.js";

export type MetricsShipOptions = {
  url: string;
  bearer?: string;
  headers?: Record<string, string>;
  intervalMs?: number;
  // Stop after this many pushes — useful for scripted runs and tests.
  maxPushes?: number;
  // When set to N > 1, render every interval but POST every Nth interval —
  // the body bundles the last N rendered snapshots, separated by a
  // "# BATCH BOUNDARY <isoTimestamp>" comment line. Net: same data volume,
  // N× fewer HTTP round-trips. Useful for high-cardinality scrapes against
  // metered endpoints.
  batchSize?: number;
  // Defaults to global fetch; overridable for tests.
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (event: MetricsShipEvent) => void;
};

export type MetricsShipEvent =
  | { phase: "render"; pushNumber: number; bytes: number; bufferedSnapshots: number }
  | { phase: "push"; pushNumber: number; bytes: number; status: number; snapshotsInBody: number }
  | { phase: "error"; pushNumber: number; error: string }
  | { phase: "stopped"; reason: "signal" | "max-pushes" };

export type MetricsShipReport = {
  pushes: number;
  errors: number;
  stoppedReason: "signal" | "max-pushes";
};

export async function shipMetricsLoop(
  db: SqliteDb,
  opts: MetricsShipOptions,
): Promise<MetricsShipReport> {
  const baseInterval = opts.intervalMs ?? 30_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const onProgress = opts.onProgress ?? (() => {});
  const headers: Record<string, string> = {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    ...(opts.headers ?? {}),
  };

  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 1));
  const buffer: string[] = [];

  let pushes = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  let stoppedReason: "signal" | "max-pushes" = "max-pushes";

  while (true) {
    if (opts.signal?.aborted) {
      stoppedReason = "signal";
      break;
    }
    pushes += 1;
    let snapshot: string;
    try {
      snapshot = renderPrometheusMetrics(db);
    } catch (error) {
      errors += 1;
      consecutiveErrors += 1;
      onProgress({ phase: "error", pushNumber: pushes, error: `render: ${(error as Error).message}` });
      await delay(backoff(baseInterval, consecutiveErrors), opts.signal);
      continue;
    }

    // Buffer the snapshot. We POST when either the buffer is full (batchSize
    // reached) or this is the final iteration before a max-pushes exit.
    buffer.push(snapshot);
    onProgress({ phase: "render", pushNumber: pushes, bytes: snapshot.length, bufferedSnapshots: buffer.length });

    const reachedMaxPushes = opts.maxPushes !== undefined && pushes >= opts.maxPushes;
    if (buffer.length >= batchSize || reachedMaxPushes) {
      const body = buffer.length === 1
        ? buffer[0]
        : buffer.map((snap, i) => `# BATCH BOUNDARY ${new Date().toISOString()} part=${i + 1}/${buffer.length}\n${snap}`).join("");
      const snapshotsInBody = buffer.length;
      buffer.length = 0;
      try {
        const response = await fetchImpl(opts.url, {
          method: "POST",
          headers,
          body,
          signal: opts.signal,
        });
        if (!response.ok) {
          errors += 1;
          consecutiveErrors += 1;
          onProgress({ phase: "error", pushNumber: pushes, error: `HTTP ${response.status}` });
        } else {
          consecutiveErrors = 0;
          onProgress({ phase: "push", pushNumber: pushes, bytes: body.length, status: response.status, snapshotsInBody });
        }
      } catch (error) {
        errors += 1;
        consecutiveErrors += 1;
        onProgress({ phase: "error", pushNumber: pushes, error: (error as Error).message });
      }
    }

    if (reachedMaxPushes) {
      stoppedReason = "max-pushes";
      break;
    }
    await delay(backoff(baseInterval, consecutiveErrors), opts.signal);
    if (opts.signal?.aborted) {
      stoppedReason = "signal";
      break;
    }
  }

  onProgress({ phase: "stopped", reason: stoppedReason });
  return { pushes, errors, stoppedReason };
}

// Cap the backoff multiplier so a long-broken endpoint waits at most ~10× the
// base interval. Two errors in a row → 2×, three → 4×, etc.
function backoff(base: number, consecutiveErrors: number): number {
  if (consecutiveErrors <= 1) return base;
  const factor = Math.min(10, 2 ** Math.min(consecutiveErrors - 1, 4));
  return base * factor;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
