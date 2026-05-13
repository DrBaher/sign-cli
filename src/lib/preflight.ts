// "Will my next create / send / sign actually work?" — runs a small battery
// of cheap checks (env vars, permissions, lightweight connectivity) against
// the resolved provider and reports each as ok / failed / skipped with an
// actionable hint. Light on purpose: NOT a full create-send-sign-verify
// cycle — that's `sign selftest` (and only works for local anyway since the
// hosted providers would send real emails).
//
// Item 6 of the product-readiness feedback. Exit code 0 if all checks pass,
// 1 if any fail (so CI gates can branch on it).

import { accessSync, constants, mkdirSync, writeFileSync, unlinkSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { canonicalUnsignedPdfPath } from "./fixtures.js";
import { checkDropboxAccount } from "./dropbox-sign.js";
import { checkSignWellAccount } from "./signwell.js";
import { resolveSignWellBaseUrl } from "./signwell.js";
import { type SignProvider } from "./providers.js";

export type PreflightCheckStatus = "ok" | "failed" | "skipped";

export type PreflightCheck = {
  name: string;
  status: PreflightCheckStatus;
  detail: string;
  /** Next-step a human can actually act on. Empty when status=ok. */
  hint?: string;
};

export type PreflightVerdict = "ok" | "failed";

export type PreflightReport = {
  provider: SignProvider;
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    verdict: PreflightVerdict;
  };
  checks: PreflightCheck[];
};

/** Make a check that just returns the result; failures don't throw, so the
 *  caller can collect every issue in one pass instead of failing on the first. */
async function tryCheck(name: string, body: () => Promise<PreflightCheck> | PreflightCheck): Promise<PreflightCheck> {
  try {
    return await body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name,
      status: "failed",
      detail: message,
      hint: "Unexpected error — see detail. If this looks like a bug, run with SIGN_DEBUG=1 for a stack trace.",
    };
  }
}

function checkDirWritable(label: string, dir: string): PreflightCheck {
  const name = `permissions:${label}`;
  // Create the dir if it doesn't exist — the local provider would do this
  // lazily anyway, so a preflight that fails because "dir doesn't exist" is
  // unhelpful. Failing only if we CAN'T create it is the right signal.
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      name,
      status: "failed",
      detail: `Cannot create ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      hint: `Ensure the parent directory exists and the current user has write permission, or set ${label === "key_dir" ? "SIGN_LOCAL_KEY_DIR" : "SIGN_LOCAL_STORE_DIR"} to a writable path.`,
    };
  }
  try {
    accessSync(dir, constants.W_OK | constants.R_OK);
  } catch {
    return {
      name,
      status: "failed",
      detail: `${dir} exists but is not readable+writable by the current user.`,
      hint: `chmod / chown the directory, or set ${label === "key_dir" ? "SIGN_LOCAL_KEY_DIR" : "SIGN_LOCAL_STORE_DIR"} to a path you control.`,
    };
  }
  // Round-trip a probe file to confirm writes actually persist (catches FS
  // quirks like read-only mounts that pass access() but reject writes).
  const probe = path.join(dir, `.preflight-probe-${process.pid}`);
  try {
    writeFileSync(probe, "ok");
    unlinkSync(probe);
  } catch (err) {
    return {
      name,
      status: "failed",
      detail: `Write probe failed on ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Filesystem may be read-only or out of space. Try a different path.",
    };
  }
  return { name, status: "ok", detail: `${dir} is readable + writable` };
}

function checkCanonicalFixture(): PreflightCheck {
  const name = "fixture:canonical_unsigned";
  const p = canonicalUnsignedPdfPath();
  if (!existsSync(p)) {
    return {
      name,
      status: "failed",
      detail: `Canonical unsigned fixture missing at ${p}`,
      hint: "Reinstall the package, or regenerate via `npm run fixture:regenerate`.",
    };
  }
  const size = statSync(p).size;
  if (size < 1000) {
    return {
      name,
      status: "failed",
      detail: `Canonical fixture looks corrupt (${size} bytes — expected ~2KB).`,
      hint: "Regenerate via `npm run fixture:regenerate`.",
    };
  }
  return { name, status: "ok", detail: `${p} (${size} bytes)` };
}

/** Node ≥ 22 is required by package.json engines and by node:sqlite. Checked
 *  every run (env-health, not provider-scoped) since older Node will pass the
 *  CLI's first few checks then crash at the first DB call. */
function checkNodeVersion(): PreflightCheck {
  const name = "runtime:node_version";
  const raw = process.versions.node;
  const major = Number(raw.split(".")[0] ?? "0");
  if (Number.isNaN(major) || major < 22) {
    return {
      name,
      status: "failed",
      detail: `node ${raw} (requires >= 22 per package.json engines + node:sqlite availability)`,
      hint: "Upgrade Node to 22 or later. The CLI uses node:sqlite which only exists on >= 22.",
    };
  }
  return { name, status: "ok", detail: `node ${raw}` };
}

/** The SQLite-backed audit chain lives at SIGN_DB_PATH (default ./data/sign.db).
 *  Catch unwritable parent dirs / read-only mounts before the first CLI op
 *  fails partway through. Env-health, runs on every provider. */
function checkDbPath(): PreflightCheck {
  const name = "storage:db_path";
  const dbPath = path.resolve(process.env.SIGN_DB_PATH ?? "./data/sign.db");
  const parent = path.dirname(dbPath);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (err) {
    return {
      name,
      status: "failed",
      detail: `Cannot create ${parent}: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Ensure the parent directory exists and is writable, or set SIGN_DB_PATH to a writable location.",
    };
  }
  // Round-trip a probe file to confirm the parent dir actually accepts
  // writes (catches read-only mounts that pass mkdir() but fail open()).
  const probe = path.join(parent, `.preflight-db-probe-${process.pid}`);
  try {
    writeFileSync(probe, "ok");
    unlinkSync(probe);
  } catch (err) {
    return {
      name,
      status: "failed",
      detail: `Write probe failed on ${parent}: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Filesystem may be read-only or out of space. Set SIGN_DB_PATH to a writable path.",
    };
  }
  return { name, status: "ok", detail: `${dbPath} is writable` };
}

function checkEnvVar(varName: string, required: boolean): PreflightCheck {
  const name = `env:${varName}`;
  const value = process.env[varName];
  if (value !== undefined && value.length > 0) {
    return { name, status: "ok", detail: "set" };
  }
  if (!required) {
    return { name, status: "skipped", detail: "not set (optional)" };
  }
  return {
    name,
    status: "failed",
    detail: "not set",
    hint: `Set ${varName} in your environment (or .env). See README for where to get it.`,
  };
}

async function checkLocalProvider(): Promise<PreflightCheck[]> {
  const keyDir = path.resolve(process.env.SIGN_LOCAL_KEY_DIR ?? "./data/local-keys");
  const storeDir = path.resolve(process.env.SIGN_LOCAL_STORE_DIR ?? "./data/local-provider");
  return [
    checkDirWritable("key_dir", keyDir),
    checkDirWritable("store_dir", storeDir),
    checkCanonicalFixture(),
  ];
}

async function checkDropboxProvider(): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const envCheck = checkEnvVar("DROPBOX_SIGN_API_KEY", true);
  checks.push(envCheck);
  // Connectivity check requires the env var; skip if it's missing rather
  // than failing twice for the same root cause.
  if (envCheck.status !== "ok") {
    checks.push({
      name: "connectivity:dropbox_account",
      status: "skipped",
      detail: "skipped because DROPBOX_SIGN_API_KEY is not set",
    });
    return checks;
  }
  checks.push(await tryCheck("connectivity:dropbox_account", async () => {
    const account = await checkDropboxAccount(process.env.DROPBOX_SIGN_API_KEY!);
    const quota = account.apiSignatureRequestsLeft;
    return {
      name: "connectivity:dropbox_account",
      status: "ok",
      detail: `Account reachable${quota !== null ? `, api quota left=${quota}` : ", but quota field absent (account may be restricted)"}`,
    };
  }));
  return checks;
}

async function checkSignWellProvider(): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];
  const envCheck = checkEnvVar("SIGNWELL_API_KEY", true);
  checks.push(envCheck);
  if (envCheck.status !== "ok") {
    checks.push({
      name: "connectivity:signwell_account",
      status: "skipped",
      detail: "skipped because SIGNWELL_API_KEY is not set",
    });
    return checks;
  }
  checks.push(await tryCheck("connectivity:signwell_account", async () => {
    const account = await checkSignWellAccount(process.env.SIGNWELL_API_KEY!, resolveSignWellBaseUrl());
    return {
      name: "connectivity:signwell_account",
      status: "ok",
      detail: `Account reachable (email=${account.email ?? "?"})`,
    };
  }));
  return checks;
}

async function checkDocuSignProvider(): Promise<PreflightCheck[]> {
  // DocuSign uses JWT auth with multiple env vars + a private key file. We
  // check presence + that the key file exists, but stop short of actually
  // issuing a token (that round-trip is non-trivial and the existing
  // `doctor account-check` covers it).
  const checks: PreflightCheck[] = [
    checkEnvVar("DOCUSIGN_INTEGRATION_KEY", true),
    checkEnvVar("DOCUSIGN_USER_ID", true),
    checkEnvVar("DOCUSIGN_ACCOUNT_ID", true),
    checkEnvVar("DOCUSIGN_BASE_PATH", true),
    checkEnvVar("DOCUSIGN_PRIVATE_KEY_PATH", true),
  ];
  const keyPathVar = process.env.DOCUSIGN_PRIVATE_KEY_PATH;
  if (keyPathVar && keyPathVar.length > 0) {
    const resolved = path.resolve(keyPathVar);
    if (!existsSync(resolved)) {
      checks.push({
        name: "permissions:docusign_private_key",
        status: "failed",
        detail: `DOCUSIGN_PRIVATE_KEY_PATH points to ${resolved} which does not exist`,
        hint: "Download the integration's RSA private key from DocuSign Admin and save it at that path.",
      });
    } else {
      checks.push({ name: "permissions:docusign_private_key", status: "ok", detail: `${resolved} exists` });
    }
  }
  return checks;
}

async function checkProfileContext(): Promise<PreflightCheck> {
  try {
    const mod = await import("./profiles.js");
    const ctx = mod.loadProfileContext({ profileFlag: undefined });
    const parts: string[] = [];
    if (ctx.activeName) parts.push(`active=${ctx.activeName}`);
    parts.push(`source=${ctx.activeSource.kind}`);
    if (ctx.projectFilePath) parts.push(`projectFile=${ctx.projectFilePath}`);
    return {
      name: "profile:active",
      status: "ok",
      detail: parts.join(" "),
    };
  } catch (err) {
    const e = err as { code?: string; message?: string; hint?: string };
    return {
      name: "profile:active",
      status: "failed",
      detail: e.message ?? String(err),
      hint: e.hint ?? "Check `sign profile list` and the profile files under $XDG_CONFIG_HOME/sign-cli.",
    };
  }
}

export async function runPreflight(provider: SignProvider): Promise<PreflightReport> {
  // Env-health checks run first on every provider — these gate the basic
  // ability to use the CLI at all, independent of which provider you pick.
  const envChecks: PreflightCheck[] = [checkNodeVersion(), checkDbPath(), await checkProfileContext()];

  let providerChecks: PreflightCheck[];
  switch (provider) {
    case "local":    providerChecks = await checkLocalProvider(); break;
    case "dropbox":  providerChecks = await checkDropboxProvider(); break;
    case "signwell": providerChecks = await checkSignWellProvider(); break;
    case "docusign": providerChecks = await checkDocuSignProvider(); break;
  }
  const checks = [...envChecks, ...providerChecks];
  const passed = checks.filter((c) => c.status === "ok").length;
  const failed = checks.filter((c) => c.status === "failed").length;
  const skipped = checks.filter((c) => c.status === "skipped").length;
  const verdict: PreflightVerdict = failed === 0 ? "ok" : "failed";
  return { provider, summary: { passed, failed, skipped, verdict }, checks };
}

export function preflightExitCode(verdict: PreflightVerdict): 0 | 1 {
  return verdict === "ok" ? 0 : 1;
}
