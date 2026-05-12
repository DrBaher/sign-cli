export const SIGN_PROVIDERS = ["dropbox", "docusign", "signwell", "local"] as const;

export type SignProvider = typeof SIGN_PROVIDERS[number];

/** Where the resolved provider came from. Used to print informative banners
 *  ("via --provider flag", "via SIGN_PROVIDER env", "default") so users can
 *  spot drift like "I meant local, but env said dropbox" without grepping. */
export type ProviderSource = "flag" | "env" | "fallback" | "default";

export type ResolvedProvider = {
  provider: SignProvider;
  source: ProviderSource;
};

function isSignProvider(value: string): value is SignProvider {
  return (SIGN_PROVIDERS as readonly string[]).includes(value);
}

function parseOrThrow(raw: string): SignProvider {
  const lower = raw.trim().toLowerCase();
  if (!isSignProvider(lower)) {
    throw new Error(`Unsupported provider: ${lower}. Expected one of: ${SIGN_PROVIDERS.join(", ")}`);
  }
  return lower;
}

export function resolveSignProvider(flag?: string, fallback?: string | null): SignProvider {
  return resolveSignProviderWithSource(flag, fallback).provider;
}

/** Same as resolveSignProvider but reports which input slot won. The source
 *  feeds the resolved-provider banner the CLI prints before every mutating
 *  command — see Item 1 of the product-readiness feedback. */
export function resolveSignProviderWithSource(
  flag?: string,
  fallback?: string | null,
): ResolvedProvider {
  if (flag !== undefined && flag !== null && flag.trim().length > 0) {
    return { provider: parseOrThrow(flag), source: "flag" };
  }
  if (fallback !== undefined && fallback !== null && fallback.length > 0) {
    return { provider: parseOrThrow(fallback), source: "fallback" };
  }
  const env = process.env.SIGN_PROVIDER;
  if (env !== undefined && env.length > 0) {
    return { provider: parseOrThrow(env), source: "env" };
  }
  return { provider: "dropbox", source: "default" };
}

/** Human-readable description of where the resolved provider came from. */
export function describeProviderSource(source: ProviderSource): string {
  switch (source) {
    case "flag":     return "via --provider flag";
    case "env":      return "via SIGN_PROVIDER env";
    case "fallback": return "persisted from request creation";
    case "default":  return "default — no flag, no SIGN_PROVIDER set";
  }
}

/** Whether the strict-provider check should fire for this invocation. The
 *  --provider flag itself does *not* imply strictness — strictness must be
 *  opted in via --strict-provider true or SIGN_STRICT_PROVIDER=true so the
 *  default behavior stays back-compatible. */
export function strictProviderEnabled(strictFlag?: string): boolean {
  if (strictFlag !== undefined && strictFlag.length > 0) {
    return strictFlag.trim().toLowerCase() === "true";
  }
  const env = (process.env.SIGN_STRICT_PROVIDER ?? "").trim().toLowerCase();
  if (env === "true") return true;
  return false;
}

/** Throws when strict provider matching is on and the runtime provider doesn't
 *  match the persisted one. Caller decides when to invoke (typically: only on
 *  commands that operate against an existing request). */
export function assertProviderMatchesPersisted(
  runtime: SignProvider,
  persisted: SignProvider,
  strict: boolean,
): void {
  if (!strict) return;
  if (runtime === persisted) return;
  throw new Error(
    `Strict provider check failed: runtime=${runtime}, persisted=${persisted}. ` +
    `The request was created against ${persisted}, but the current command resolved to ${runtime}. ` +
    `Either rerun with --provider ${persisted}, or unset --strict-provider/SIGN_STRICT_PROVIDER to bypass.`,
  );
}
