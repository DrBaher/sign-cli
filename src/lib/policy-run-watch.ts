// `signer policy run-watch` glue: watch the inbox; on every new entry, run the
// policy spec against it (if a token is on file). Composes runSignerWatch +
// runSignerPolicy without coupling either side to the other.
//
// Why a wrapper instead of a flag on runSignerPolicyAll:
//   * run-all is a one-shot batch — the inbox snapshot at call time.
//   * run-watch is a long-running tail. They have different exit semantics
//     (exit code 4 on timeout vs. exit code 3 on per-row failure).
//
// The function shares the `tokens` map shape with runSignerPolicyAll for ops
// who want to switch between batch and continuous modes without re-shaping
// their roster file.

import type { SqliteDb } from "./db.js";
import type { PolicyDecision, PolicySpec } from "./policy-engine.js";
import { runSignerPolicy } from "./signing-service.js";
import { runSignerWatch, type SignerWatchOutcome } from "./signer-watch.js";

export type PolicyRunWatchEntry = {
  requestId: string;
  signerEmail: string | null;
  ok: boolean;
  decision: PolicyDecision | null;
  applied: boolean;
  error: { code: string; message: string } | null;
  // "skipped" means there was no token on file for this requestId — the
  // watcher saw it but couldn't act. Useful signal for an operator who's
  // forgotten to refresh their tokens file.
  skipped: boolean;
};

export type PolicyRunWatchOutcome = {
  watch: SignerWatchOutcome;
  evaluated: PolicyRunWatchEntry[];
  succeeded: number;
  failed: number;
  skipped: number;
};

export async function runSignerPolicyWatch(
  db: SqliteDb,
  input: {
    tokens: Record<string, string>;
    spec: PolicySpec;
    signerEmail?: string;
    exitOnFirst?: boolean;
    timeoutMs?: number;
    pollIntervalMs?: number;
    dryRun?: boolean;
    now?: () => Date;
    onEntry?: (entry: PolicyRunWatchEntry) => void;
    // ISO-8601 cutoff. Entries with createdAt < this are skipped without
    // firing onEntry — useful when an anchor has already attested to all
    // chains up to that point and you only want to act on what's newer.
    sinceCreatedAt?: string;
  },
): Promise<PolicyRunWatchOutcome> {
  const cutoffMs = input.sinceCreatedAt ? Date.parse(input.sinceCreatedAt) : null;
  const evaluated: PolicyRunWatchEntry[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  const watch = await runSignerWatch(db, {
    signerEmail: input.signerEmail,
    exitOnFirst: input.exitOnFirst,
    timeoutMs: input.timeoutMs,
    pollIntervalMs: input.pollIntervalMs,
    now: input.now,
    onEntry: (entry) => {
      // Only act on truly-new entries — the initial snapshot is informational.
      if (!entry.firstSeen || !entry.requestId) return;
      if (cutoffMs !== null) {
        const entryMs = Date.parse(entry.createdAt);
        if (Number.isFinite(entryMs) && entryMs < cutoffMs) return;
      }
      const requestId = entry.requestId;
      const token = input.tokens[requestId];
      if (!token) {
        const row: PolicyRunWatchEntry = {
          requestId,
          signerEmail: entry.signers?.[0]?.email ?? null,
          ok: false,
          decision: null,
          applied: false,
          error: null,
          skipped: true,
        };
        evaluated.push(row);
        skipped += 1;
        input.onEntry?.(row);
        return;
      }
      try {
        const outcome = runSignerPolicy(db, {
          requestId,
          token,
          spec: input.spec,
          dryRun: input.dryRun,
          now: input.now ? input.now() : undefined,
        });
        const row: PolicyRunWatchEntry = {
          requestId: outcome.requestId,
          signerEmail: outcome.signerEmail,
          ok: true,
          decision: outcome.decision,
          applied: outcome.applied,
          error: null,
          skipped: false,
        };
        evaluated.push(row);
        succeeded += 1;
        input.onEntry?.(row);
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        const message = error instanceof Error ? error.message : String(error);
        const row: PolicyRunWatchEntry = {
          requestId,
          signerEmail: entry.signers?.[0]?.email ?? null,
          ok: false,
          decision: null,
          applied: false,
          error: { code: typeof code === "string" ? code : "INTERNAL", message },
          skipped: false,
        };
        evaluated.push(row);
        failed += 1;
        input.onEntry?.(row);
      }
    },
  });

  return { watch, evaluated, succeeded, failed, skipped };
}
