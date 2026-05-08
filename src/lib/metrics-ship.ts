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
  // Defaults to global fetch; overridable for tests.
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (event: MetricsShipEvent) => void;
};

export type MetricsShipEvent =
  | { phase: "push"; pushNumber: number; bytes: number; status: number }
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
    let body: string;
    try {
      body = renderPrometheusMetrics(db);
    } catch (error) {
      errors += 1;
      consecutiveErrors += 1;
      onProgress({ phase: "error", pushNumber: pushes, error: `render: ${(error as Error).message}` });
      await delay(backoff(baseInterval, consecutiveErrors), opts.signal);
      continue;
    }
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
        onProgress({ phase: "push", pushNumber: pushes, bytes: body.length, status: response.status });
      }
    } catch (error) {
      errors += 1;
      consecutiveErrors += 1;
      onProgress({ phase: "error", pushNumber: pushes, error: (error as Error).message });
    }

    if (opts.maxPushes !== undefined && pushes >= opts.maxPushes) {
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
