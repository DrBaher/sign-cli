import { statSync } from "node:fs";
import path from "node:path";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const DEFAULTS = {
  maxDocumentBytes: 25 * 1024 * 1024,
  maxSigners: 50,
  maxFields: 200,
  maxPrefills: 200,
  maxBulkRows: 1000,
};

export function resolveMaxDocumentBytes(): number {
  const env = process.env.SIGN_MAX_DOCUMENT_BYTES;
  if (env !== undefined) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULTS.maxDocumentBytes;
}

export function validateEmail(email: string, label = "email"): void {
  if (!EMAIL_REGEX.test(email)) {
    throw new Error(`${label} is not a valid email address: "${email}"`);
  }
}

export function validateReturnUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`--return-url is not a valid URL: "${url}"`);
  }
  if (parsed.protocol === "javascript:" || parsed.protocol === "file:" || parsed.protocol === "data:") {
    throw new Error(`--return-url protocol "${parsed.protocol}" is not allowed.`);
  }
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol === "http:" && !isLocalhost) {
    throw new Error(`--return-url must use https:// (got "${parsed.protocol}//${parsed.hostname}"). Localhost is allowed for development.`);
  }
  // Optional host allowlist. By default any https host is accepted (the
  // return URL is where the signer's browser lands after signing). Operators
  // who want to prevent an agent from steering signers to an arbitrary domain
  // can pin a comma-separated allowlist via SIGN_RETURN_URL_ALLOWED_HOSTS;
  // hostnames match exactly (no wildcard), localhost is always allowed.
  const allowList = (process.env.SIGN_RETURN_URL_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowList.length > 0 && !isLocalhost && !allowList.includes(parsed.hostname.toLowerCase())) {
    throw new Error(
      `--return-url host "${parsed.hostname}" is not in SIGN_RETURN_URL_ALLOWED_HOSTS (${allowList.join(", ")}).`,
    );
  }
}

export type DocumentPathRule = {
  cwd?: string;
  allowAbsoluteOutsideCwd?: boolean;
  maxBytes?: number;
};

/** Config-path validator for values stored in a profile or other long-lived
 *  config (notably `sign profile init --db <path>`). More permissive than
 *  validateOutputPath: home-relative paths (`~/...`, `~`) are accepted
 *  without the SIGN_ALLOW_ABSOLUTE_DOCS opt-in, because the canonical
 *  example is `~/.sign-cli/prod.db`. Other absolute paths still require
 *  the opt-in. Returns the path with `~` expanded.
 *
 *  The traversal protection is still there: `../../../etc/sign.db` is
 *  rejected unless the user opts in explicitly. */
export function validateConfigPath(
  rawPath: string,
  rule: { cwd?: string; home?: string } = {},
): string {
  const home = rule.home ?? (process.env.HOME ?? "/");
  const cwd = rule.cwd ?? process.cwd();
  // Home-relative shortcut: `~`, `~/foo` → expand to absolute under $HOME.
  let working = rawPath;
  if (working === "~") working = home;
  else if (working.startsWith("~/")) working = path.join(home, working.slice(2));
  const resolved = path.resolve(cwd, working);
  // OK if resolved sits under $HOME OR under cwd.
  const homeResolved = path.resolve(home);
  const cwdResolved = path.resolve(cwd);
  const insideHome = !path.relative(homeResolved, resolved).startsWith("..") && !path.isAbsolute(path.relative(homeResolved, resolved));
  const insideCwd = !path.relative(cwdResolved, resolved).startsWith("..") && !path.isAbsolute(path.relative(cwdResolved, resolved));
  if (insideHome || insideCwd) return resolved;
  // Otherwise: require the opt-in.
  const allow = (process.env.SIGN_ALLOW_ABSOLUTE_DOCS ?? "").toLowerCase();
  if (["1", "true", "yes"].includes(allow)) return resolved;
  throw new Error(
    `Config path "${rawPath}" is outside both $HOME (${home}) and CWD (${cwd}). ` +
    `Set SIGN_ALLOW_ABSOLUTE_DOCS=1 to override.`,
  );
}

/** Output-path counterpart to validateDocumentPath. Only enforces the
 *  traversal check (the path doesn't have to exist yet — we're about to
 *  write to it). Override with SIGN_ALLOW_ABSOLUTE_DOCS=1 (same toggle as
 *  the input-path validator, on purpose: one knob for "let me read/write
 *  paths outside the cwd"). Used by `pdf stamp --out`, `pdf stamp-text
 *  --out`, `preview --out`, `document --out`, and `profile init --db`. */
export function validateOutputPath(
  rawPath: string,
  rule: { cwd?: string; allowAbsoluteOutsideCwd?: boolean } = {},
): string {
  const cwd = rule.cwd ?? process.cwd();
  const resolved = path.resolve(cwd, rawPath);
  if (rule.allowAbsoluteOutsideCwd) return resolved;
  const allow = (process.env.SIGN_ALLOW_ABSOLUTE_DOCS ?? "").toLowerCase();
  if (["1", "true", "yes"].includes(allow)) return resolved;
  const cwdResolved = path.resolve(cwd);
  const relative = path.relative(cwdResolved, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Output path escapes the working directory: "${rawPath}". Set SIGN_ALLOW_ABSOLUTE_DOCS=1 to override.`,
    );
  }
  return resolved;
}

export function validateDocumentPath(rawPath: string, rule: DocumentPathRule = {}): { resolved: string; bytes: number } {
  const cwd = rule.cwd ?? process.cwd();
  const resolved = path.resolve(cwd, rawPath);
  if (!rule.allowAbsoluteOutsideCwd) {
    const allow = (process.env.SIGN_ALLOW_ABSOLUTE_DOCS ?? "").toLowerCase();
    const permissive = ["1", "true", "yes"].includes(allow);
    if (!permissive) {
      const cwdResolved = path.resolve(cwd);
      const relative = path.relative(cwdResolved, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(
          `Document path escapes the working directory: "${rawPath}". Set SIGN_ALLOW_ABSOLUTE_DOCS=1 to override.`,
        );
      }
    }
  }
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(`Document not found: "${rawPath}" (resolved to "${resolved}").`);
  }
  if (!stats.isFile()) {
    throw new Error(`Document path is not a file: "${rawPath}".`);
  }
  const limit = rule.maxBytes ?? resolveMaxDocumentBytes();
  if (stats.size > limit) {
    throw new Error(`Document "${rawPath}" is ${stats.size} bytes, exceeding the limit of ${limit} bytes (override with SIGN_MAX_DOCUMENT_BYTES).`);
  }
  return { resolved, bytes: stats.size };
}

export function validateSignerCount(count: number, maxSigners: number = DEFAULTS.maxSigners): void {
  if (count > maxSigners) {
    throw new Error(`Too many signers: ${count} (limit ${maxSigners}).`);
  }
}

export function validateFieldCount(count: number, maxFields: number = DEFAULTS.maxFields): void {
  if (count > maxFields) {
    throw new Error(`Too many --field entries: ${count} (limit ${maxFields}).`);
  }
}

export function validateBulkRowCount(count: number, maxBulkRows: number = DEFAULTS.maxBulkRows): void {
  if (count > maxBulkRows) {
    throw new Error(`Too many CSV rows: ${count} (limit ${maxBulkRows}).`);
  }
}
