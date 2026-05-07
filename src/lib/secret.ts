import crypto from "node:crypto";

const SENSITIVE_HEADER_REGEX = /^(authorization|x-api-key|x-signwell|cookie|set-cookie|proxy-authorization)/i;

export function fingerprintSecret(value: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const hash = crypto.createHash("sha256").update(trimmed).digest("hex");
  const prefix = trimmed.slice(0, 4);
  return `${prefix}***${hash.slice(0, 8)}`;
}

export function redactSecretValue(value: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.length <= 6) return "***";
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

export function redactString(text: string, secrets: ReadonlyArray<string | undefined | null>): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret) continue;
    const trimmed = secret.trim();
    if (trimmed.length < 4) continue;
    const replacement = redactSecretValue(trimmed);
    output = output.split(trimmed).join(replacement);
  }
  return output;
}

export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const stringValue = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    if (SENSITIVE_HEADER_REGEX.test(key)) {
      out[key] = redactSecretValue(stringValue);
    } else {
      out[key] = stringValue;
    }
  }
  return out;
}

export function collectKnownSecrets(): string[] {
  const keys = [
    "DROPBOX_SIGN_API_KEY",
    "SIGNWELL_API_KEY",
    "SIGNWELL_WEBHOOK_SECRET",
    "DOCUSIGN_INTEGRATION_KEY",
  ];
  const out: string[] = [];
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) out.push(value);
  }
  return out;
}

export function redactErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactString(raw, collectKnownSecrets());
}
