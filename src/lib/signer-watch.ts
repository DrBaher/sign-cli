import type { SqliteDb } from "./db.js";
import { subscribeResource } from "./resource-watch.js";
import { listSignerInbox, type SignerInboxItem } from "./signing-service.js";

export type SignerWatchOptions = {
  signerEmail?: string;
  exitOnFirst?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onEntry?: (entry: SignerInboxItem & { firstSeen: boolean }) => void;
  now?: () => Date;
};

export type SignerWatchOutcome = {
  exitReason: "exit_on_first" | "timeout" | "stopped";
  startedAt: string;
  elapsedMs: number;
  initialEntries: SignerInboxItem[];
  newEntries: SignerInboxItem[];
};

export async function runSignerWatch(
  db: SqliteDb,
  opts: SignerWatchOptions = {},
): Promise<SignerWatchOutcome> {
  const now = opts.now ?? (() => new Date());
  const startedAtMs = now().getTime();
  const startedAt = new Date(startedAtMs).toISOString();
  const seen = new Set<string>();

  const initial = listSignerInbox(db, { signerEmail: opts.signerEmail, now: now() });
  for (const entry of initial) {
    if (entry.requestId) seen.add(entry.requestId);
    opts.onEntry?.({ ...entry, firstSeen: false });
  }

  const newEntries: SignerInboxItem[] = [];
  let stopped = false;
  let exitReason: SignerWatchOutcome["exitReason"] = "stopped";

  const checkInbox = (): boolean => {
    const current = listSignerInbox(db, { signerEmail: opts.signerEmail, now: now() });
    let foundNew = false;
    for (const entry of current) {
      const id = entry.requestId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      newEntries.push(entry);
      foundNew = true;
      opts.onEntry?.({ ...entry, firstSeen: true });
    }
    return foundNew;
  };

  const unsubscribe = subscribeResource("*", () => {
    if (stopped) return;
    if (checkInbox() && opts.exitOnFirst) {
      stopped = true;
      exitReason = "exit_on_first";
    }
  });

  // Belt-and-suspenders: also poll every pollIntervalMs in case a notification
  // is missed (e.g. the audit insert happens in another process that doesn't
  // share our resource-watch registry — current implementation is in-process,
  // so this is mostly a no-op safety net).
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const timeoutMs = opts.timeoutMs;

  try {
    while (!stopped) {
      if (typeof timeoutMs === "number" && timeoutMs >= 0) {
        const elapsed = now().getTime() - startedAtMs;
        if (elapsed >= timeoutMs) {
          exitReason = "timeout";
          break;
        }
      }
      // Initial entries already covered exit_on_first — but the loop covers
      // the case where new entries appeared between subscribe() and the first
      // sleep tick.
      if (opts.exitOnFirst) {
        if (checkInbox()) {
          exitReason = "exit_on_first";
          break;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  } finally {
    unsubscribe();
  }

  return {
    exitReason,
    startedAt,
    elapsedMs: now().getTime() - startedAtMs,
    initialEntries: initial,
    newEntries,
  };
}
