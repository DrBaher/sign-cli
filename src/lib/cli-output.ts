// Output helpers for the CLI: a stderr banner that prints the resolved
// provider + how it was resolved, and a JSON emitter that merges the same
// info into the structured output.
//
// Both exist because of the "provider drift" feedback (Item 1 of the
// product-readiness review): users would type --provider local intending
// local execution but the command would silently run against dropbox if
// .env had SIGN_PROVIDER=dropbox or the flag was missing. The banner makes
// the resolution visible; the JSON field lets ops tools assert on it.

import { describeProviderSource, type ResolvedProvider } from "./providers.js";

/** Print "[sign] resolved provider: <p> (<source>)" to stderr. No-op for
 *  commands that don't care about provider (audit verify, db migrate, etc.). */
export function printProviderBanner(resolved: ResolvedProvider): void {
  // We can't suppress this with a quiet flag yet — if someone needs that,
  // route it through SIGN_QUIET_BANNER later. For now: always print, always
  // to stderr (so JSON stdout pipelines keep working unchanged).
  process.stderr.write(
    `[sign] resolved provider: ${resolved.provider} (${describeProviderSource(resolved.source)})\n`,
  );
}

/** Print a JSON payload to stdout, optionally merging in resolved_provider.
 *  Caller signature mirrors `console.log(JSON.stringify(payload, null, 2))`. */
export function emitJsonWithProvider(
  payload: unknown,
  resolved?: ResolvedProvider,
): void {
  if (resolved && payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const merged = {
      resolved_provider: { provider: resolved.provider, source: resolved.source },
      ...(payload as Record<string, unknown>),
    };
    console.log(JSON.stringify(merged, null, 2));
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}
