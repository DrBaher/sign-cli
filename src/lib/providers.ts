export const SIGN_PROVIDERS = ["dropbox", "docusign", "signwell", "local"] as const;

export type SignProvider = typeof SIGN_PROVIDERS[number];

function isSignProvider(value: string): value is SignProvider {
  return (SIGN_PROVIDERS as readonly string[]).includes(value);
}

export function resolveSignProvider(flag?: string, fallback?: string | null): SignProvider {
  const raw = (flag ?? fallback ?? process.env.SIGN_PROVIDER ?? "dropbox").trim().toLowerCase();
  if (!isSignProvider(raw)) {
    throw new Error(`Unsupported provider: ${raw}. Expected one of: ${SIGN_PROVIDERS.join(", ")}`);
  }
  return raw;
}
