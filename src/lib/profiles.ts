// Profiles — named bundles of provider + DB + credentials defaults.
//
// Loading model:
//
//   1. Project file: walk up from CWD to find `sign-profile.json`.
//      Stops at $HOME or the filesystem root. The first hit wins.
//
//   2. User file: `$XDG_CONFIG_HOME/sign-cli/profiles.json` (falls back
//      to `~/.config/sign-cli/profiles.json`). Schema is
//      `{ version, defaultProfile?, profiles: { <name>: <profile> } }`.
//
//   3. Active profile name (which entry in the user file is "live"):
//        flag (--profile <name>)
//        > env  (SIGN_PROFILE=<name>)
//        > defaultProfile from the user file
//        > (none — only the project file applies)
//
// Per-field resolution: flag > env > project profile > user profile >
// fallback (e.g. persisted provider on a request) > default. Implemented
// once via `resolveFromProfile()` and consumed by every call site that
// previously did `flag > env > default`.
//
// Credentials: atomic — the layer that resolved `provider` contributes
// its credentials block. We do NOT merge credentials across layers so
// that profile switches can never silently leak the prior profile's
// secrets. Cross-profile reuse is handled by `{{env:VAR}}` references
// inside the credentials block.
//
// `{{env:VAR}}` expansion: applied to string fields at load time. An
// unset env var throws `PROFILE_ENV_VAR_UNSET` with a clear hint — we
// never silently expand to "" because that becomes "wrong credentials"
// bugs at adapter time.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { SIGN_PROVIDERS, type SignProvider } from "./providers.js";
import { SignCliError } from "./sign-error.js";

export const CURRENT_PROFILE_SCHEMA_VERSION = 1;

export type ProfileV1 = {
  version: 1;
  provider?: SignProvider;
  strictProvider?: boolean;
  dbPath?: string;
  defaultTokenTtlMinutes?: number;
  defaultSignerEmail?: string;
  /** Env-var-name → value map. Each value may use `{{env:OTHER_VAR}}` to
   *  pull in shell-managed secrets without baking them into the file. */
  credentials?: Record<string, string>;
};

export type UserProfilesFile = {
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, ProfileV1>;
};

export type ProfileSource =
  | { kind: "none" }
  | { kind: "flag"; name: string }
  | { kind: "env"; name: string }
  | { kind: "default-profile"; name: string }
  | { kind: "project-file"; path: string };

export type ProfileContext = {
  /** Name of the active user profile (if any). */
  activeName?: string;
  /** How the active profile was selected. */
  activeSource: ProfileSource;
  /** Loaded user profile (selected by `activeName`), if a user file exists. */
  userProfile?: ProfileV1;
  /** Loaded project profile (from upward `sign-profile.json` walk). */
  projectProfile?: ProfileV1;
  /** Filesystem paths for diagnostics. */
  userFilePath: string;
  projectFilePath?: string;
};

export type FieldSourceKind = "flag" | "env" | "project" | "user" | "fallback" | "default";

export type ResolvedField<T> = {
  value: T;
  source: FieldSourceKind;
};

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function defaultUserFilePath(): string {
  // Explicit override wins (testing + advanced users).
  if (process.env.SIGN_PROFILES_FILE) return process.env.SIGN_PROFILES_FILE;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return path.join(xdg, "sign-cli", "profiles.json");
  return path.join(homedir(), ".config", "sign-cli", "profiles.json");
}

const PROJECT_FILE_NAME = "sign-profile.json";

/** Walk up from `startDir` toward $HOME or the filesystem root and return
 *  the first `sign-profile.json` found, or null. */
export function findProjectFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  const stopAt = path.resolve(homedir());
  // Hard cap on hops in case of unusual filesystems / mount points.
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, PROJECT_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    if (dir === stopAt) return null;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_PROFILE_KEYS = new Set<string>([
  "version", "provider", "strictProvider", "dbPath",
  "defaultTokenTtlMinutes", "defaultSignerEmail", "credentials",
]);

const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new SignCliError({
      code: "INVALID_PROFILE_NAME",
      message: `Invalid profile name: ${JSON.stringify(name)}. Names must match [A-Za-z0-9._-]+ (no spaces, no slashes).`,
    });
  }
}

/** Schema-validate a raw profile and return it as ProfileV1 with NO
 *  `{{env:VAR}}` / `~` expansion applied. Use this for write paths so the
 *  file preserves the literal reference; load paths call expandProfile()
 *  after validation. */
function validateProfileShapeRaw(raw: unknown, label: string): ProfileV1 {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SignCliError({ code: "INVALID_PROFILE", message: `${label}: expected an object.` });
  }
  const p = raw as Record<string, unknown>;
  if (p.version !== 1) {
    throw new SignCliError({
      code: "INVALID_PROFILE",
      message: `${label}: unsupported version ${JSON.stringify(p.version)} (expected 1).`,
      hint: `If this profile was written by a newer sign-cli, update the CLI. For older versions, run \`sign profile migrate\`.`,
    });
  }
  // Reject unknown keys loudly so typos like `defaultTokenTtl` don't silently
  // fall through to the default value.
  for (const key of Object.keys(p)) {
    if (!VALID_PROFILE_KEYS.has(key)) {
      throw new SignCliError({
        code: "INVALID_PROFILE",
        message: `${label}: unknown field ${JSON.stringify(key)}. Valid: ${Array.from(VALID_PROFILE_KEYS).join(", ")}.`,
      });
    }
  }
  if (p.provider !== undefined && !(SIGN_PROVIDERS as readonly string[]).includes(p.provider as string)) {
    throw new SignCliError({
      code: "INVALID_PROFILE",
      message: `${label}: invalid provider ${JSON.stringify(p.provider)}. Expected one of: ${SIGN_PROVIDERS.join(", ")}.`,
    });
  }
  if (p.strictProvider !== undefined && typeof p.strictProvider !== "boolean") {
    throw new SignCliError({
      code: "INVALID_PROFILE",
      message: `${label}: strictProvider must be a boolean.`,
    });
  }
  if (p.dbPath !== undefined && typeof p.dbPath !== "string") {
    throw new SignCliError({ code: "INVALID_PROFILE", message: `${label}: dbPath must be a string.` });
  }
  if (p.defaultTokenTtlMinutes !== undefined) {
    if (typeof p.defaultTokenTtlMinutes !== "number" || !Number.isFinite(p.defaultTokenTtlMinutes) || p.defaultTokenTtlMinutes <= 0) {
      throw new SignCliError({
        code: "INVALID_PROFILE",
        message: `${label}: defaultTokenTtlMinutes must be a positive number.`,
      });
    }
  }
  if (p.defaultSignerEmail !== undefined && typeof p.defaultSignerEmail !== "string") {
    throw new SignCliError({
      code: "INVALID_PROFILE",
      message: `${label}: defaultSignerEmail must be a string.`,
    });
  }
  if (p.credentials !== undefined) {
    if (typeof p.credentials !== "object" || p.credentials === null || Array.isArray(p.credentials)) {
      throw new SignCliError({
        code: "INVALID_PROFILE",
        message: `${label}: credentials must be a string-to-string map.`,
      });
    }
    for (const [k, v] of Object.entries(p.credentials)) {
      if (typeof v !== "string") {
        throw new SignCliError({
          code: "INVALID_PROFILE",
          message: `${label}: credentials.${k} must be a string (got ${typeof v}).`,
        });
      }
    }
  }
  // Strip unknown keys and cast — expansion happens separately (load only).
  const validated: ProfileV1 = { version: 1 };
  if (p.provider !== undefined) validated.provider = p.provider as SignProvider;
  if (p.strictProvider !== undefined) validated.strictProvider = p.strictProvider as boolean;
  if (p.dbPath !== undefined) validated.dbPath = p.dbPath as string;
  if (p.defaultTokenTtlMinutes !== undefined) validated.defaultTokenTtlMinutes = p.defaultTokenTtlMinutes as number;
  if (p.defaultSignerEmail !== undefined) validated.defaultSignerEmail = p.defaultSignerEmail as string;
  if (p.credentials !== undefined) validated.credentials = { ...(p.credentials as Record<string, string>) };
  return validated;
}

/** Validate AND expand. Used by load paths. */
function validateAndExpand(raw: unknown, label: string): ProfileV1 {
  return expandProfile(validateProfileShapeRaw(raw, label), label);
}

// ---------------------------------------------------------------------------
// {{env:VAR}} and ~ expansion
// ---------------------------------------------------------------------------

const ENV_REF_RE = /\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function expandEnvRefs(value: string, label: string): string {
  return value.replace(ENV_REF_RE, (_, varName: string) => {
    const v = process.env[varName];
    if (v === undefined) {
      throw new SignCliError({
        code: "PROFILE_ENV_VAR_UNSET",
        message: `${label}: references {{env:${varName}}} but ${varName} is not set in the environment.`,
        hint: `Export ${varName} before running, or remove the reference from the profile.`,
      });
    }
    return v;
  });
}

function expandHomePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function expandProfile(p: Partial<ProfileV1> & { version: 1 }, label: string): ProfileV1 {
  const out: ProfileV1 = { version: 1 };
  if (p.provider !== undefined) out.provider = p.provider;
  if (p.strictProvider !== undefined) out.strictProvider = p.strictProvider;
  if (p.dbPath !== undefined) out.dbPath = expandHomePath(expandEnvRefs(p.dbPath, `${label}.dbPath`));
  if (p.defaultTokenTtlMinutes !== undefined) out.defaultTokenTtlMinutes = p.defaultTokenTtlMinutes;
  if (p.defaultSignerEmail !== undefined) {
    out.defaultSignerEmail = expandEnvRefs(p.defaultSignerEmail, `${label}.defaultSignerEmail`);
  }
  if (p.credentials !== undefined) {
    const creds: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.credentials)) {
      creds[k] = expandEnvRefs(v, `${label}.credentials.${k}`);
    }
    out.credentials = creds;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Load + save
// ---------------------------------------------------------------------------

export function readUserFile(filePath: string): UserProfilesFile | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new SignCliError({
      code: "INVALID_PROFILE",
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SignCliError({ code: "INVALID_PROFILE", message: `${filePath}: expected JSON object.` });
  }
  const file = parsed as Partial<UserProfilesFile>;
  if (file.version !== 1) {
    throw new SignCliError({
      code: "INVALID_PROFILE",
      message: `${filePath}: unsupported file version ${JSON.stringify(file.version)} (expected 1).`,
    });
  }
  if (!file.profiles || typeof file.profiles !== "object" || Array.isArray(file.profiles)) {
    throw new SignCliError({ code: "INVALID_PROFILE", message: `${filePath}: missing 'profiles' map.` });
  }
  const profiles: Record<string, ProfileV1> = {};
  for (const [name, value] of Object.entries(file.profiles)) {
    validateProfileName(name);
    profiles[name] = validateAndExpand(value, `${filePath}.profiles.${name}`);
  }
  return {
    version: 1,
    ...(typeof file.defaultProfile === "string" ? { defaultProfile: file.defaultProfile } : {}),
    profiles,
  };
}

export function readProjectFile(filePath: string): ProfileV1 | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new SignCliError({
      code: "INVALID_PROFILE",
      message: `Failed to parse ${filePath}: ${(err as Error).message}`,
    });
  }
  return validateAndExpand(parsed, filePath);
}

export function writeUserFile(filePath: string, file: UserProfilesFile): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ordered: UserProfilesFile = {
    version: 1,
    ...(file.defaultProfile ? { defaultProfile: file.defaultProfile } : {}),
    profiles: Object.fromEntries(
      Object.keys(file.profiles).sort().map((k) => [k, file.profiles[k]]),
    ),
  };
  writeFileSync(filePath, JSON.stringify(ordered, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(filePath, 0o600); } catch { /* best-effort */ }
}

export function writeProjectFile(filePath: string, profile: ProfileV1): void {
  writeFileSync(filePath, JSON.stringify(profile, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Resolve active context
// ---------------------------------------------------------------------------

export function loadProfileContext(opts: {
  profileFlag?: string;
  cwd?: string;
  userFilePath?: string;
}): ProfileContext {
  const userFilePath = opts.userFilePath ?? defaultUserFilePath();
  const cwd = opts.cwd ?? process.cwd();
  const projectFilePath = findProjectFile(cwd) ?? undefined;

  const projectProfile = projectFilePath ? readProjectFile(projectFilePath) ?? undefined : undefined;
  const userFile = readUserFile(userFilePath) ?? undefined;

  let activeName: string | undefined;
  let activeSource: ProfileSource = { kind: "none" };
  if (opts.profileFlag && opts.profileFlag.length > 0) {
    validateProfileName(opts.profileFlag);
    activeName = opts.profileFlag;
    activeSource = { kind: "flag", name: opts.profileFlag };
  } else if (process.env.SIGN_PROFILE && process.env.SIGN_PROFILE.length > 0) {
    const envName = process.env.SIGN_PROFILE;
    validateProfileName(envName);
    activeName = envName;
    activeSource = { kind: "env", name: envName };
  } else if (userFile?.defaultProfile) {
    activeName = userFile.defaultProfile;
    activeSource = { kind: "default-profile", name: userFile.defaultProfile };
  } else if (projectFilePath) {
    activeSource = { kind: "project-file", path: projectFilePath };
  }

  let userProfile: ProfileV1 | undefined;
  if (activeName) {
    userProfile = userFile?.profiles[activeName];
    if (!userProfile) {
      throw new SignCliError({
        code: "PROFILE_NOT_FOUND",
        message: `No profile named '${activeName}' in ${userFilePath}.`,
        hint: userFile
          ? `Available profiles: ${Object.keys(userFile.profiles).sort().join(", ") || "(none)"}.`
          : `No user profile file exists yet. Create one with \`sign profile init --name ${activeName}\`.`,
      });
    }
  }

  return { activeName, activeSource, projectProfile, userProfile, userFilePath, projectFilePath };
}

// ---------------------------------------------------------------------------
// Per-field resolution
// ---------------------------------------------------------------------------

export type ProfileLayerSource = "project" | "user";

export function resolveFromProfile<K extends keyof ProfileV1>(
  key: K,
  ctx: ProfileContext,
): { value: NonNullable<ProfileV1[K]>; source: ProfileLayerSource } | null {
  if (ctx.projectProfile && ctx.projectProfile[key] !== undefined) {
    return { value: ctx.projectProfile[key] as NonNullable<ProfileV1[K]>, source: "project" };
  }
  if (ctx.userProfile && ctx.userProfile[key] !== undefined) {
    return { value: ctx.userProfile[key] as NonNullable<ProfileV1[K]>, source: "user" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apply credentials → process.env (atomic, no cross-layer merge)
// ---------------------------------------------------------------------------

export function applyCredentialsToProcessEnv(ctx: ProfileContext): { applied: number; sourceLayer: "project" | "user" | null } {
  // The layer that resolved `provider` contributes its credentials. If
  // neither layer set `provider`, neither contributes credentials (the
  // fallback layer / built-in default doesn't have credentials).
  const providerSource = resolveFromProfile("provider", ctx);
  if (!providerSource) return { applied: 0, sourceLayer: null };
  const sourceProfile = providerSource.source === "project" ? ctx.projectProfile! : ctx.userProfile!;
  const creds = sourceProfile.credentials;
  if (!creds) return { applied: 0, sourceLayer: providerSource.source };
  let applied = 0;
  for (const [name, value] of Object.entries(creds)) {
    process.env[name] = value;
    applied += 1;
  }
  return { applied, sourceLayer: providerSource.source };
}

// ---------------------------------------------------------------------------
// Redaction (for `sign profile show` without --show-secrets)
// ---------------------------------------------------------------------------

const REDACTION_PLACEHOLDER = "***";

export function redactCredentials(profile: ProfileV1): ProfileV1 {
  if (!profile.credentials) return profile;
  const redacted: Record<string, string> = {};
  for (const k of Object.keys(profile.credentials)) redacted[k] = REDACTION_PLACEHOLDER;
  return { ...profile, credentials: redacted };
}

// ---------------------------------------------------------------------------
// Resolved view (for `sign profile show` provenance display)
// ---------------------------------------------------------------------------

export type ResolvedProfileView = {
  active: { name?: string; source: ProfileSource };
  fields: {
    provider?: { value: SignProvider; source: "project" | "user" };
    strictProvider?: { value: boolean; source: "project" | "user" };
    dbPath?: { value: string; source: "project" | "user" };
    defaultTokenTtlMinutes?: { value: number; source: "project" | "user" };
    defaultSignerEmail?: { value: string; source: "project" | "user" };
  };
  credentials?: {
    /** Credential names. Always present when there are credentials. */
    keys: string[];
    /** Resolved (post-{{env:}}-expansion) values, ONLY when showSecrets:true. */
    values?: Record<string, string>;
    sourceLayer: "project" | "user" | null;
  };
  userFilePath: string;
  projectFilePath?: string;
};

export function resolveProfileView(ctx: ProfileContext, opts: { showSecrets?: boolean } = {}): ResolvedProfileView {
  const out: ResolvedProfileView = {
    active: { name: ctx.activeName, source: ctx.activeSource },
    fields: {},
    userFilePath: ctx.userFilePath,
    projectFilePath: ctx.projectFilePath,
  };
  for (const key of ["provider", "strictProvider", "dbPath", "defaultTokenTtlMinutes", "defaultSignerEmail"] as const) {
    const r = resolveFromProfile(key, ctx);
    if (!r) continue;
    // The per-field type is satisfied by construction; TypeScript can't
    // narrow across the loop body, hence the cast.
    (out.fields as Record<string, { value: unknown; source: ProfileLayerSource }>)[key] = { value: r.value, source: r.source };
  }
  const providerSource = resolveFromProfile("provider", ctx);
  if (providerSource) {
    const sourceProfile = providerSource.source === "project" ? ctx.projectProfile : ctx.userProfile;
    const creds = sourceProfile?.credentials;
    if (creds && Object.keys(creds).length > 0) {
      out.credentials = {
        keys: Object.keys(creds).sort(),
        ...(opts.showSecrets ? { values: { ...creds } } : {}),
        sourceLayer: providerSource.source as "project" | "user",
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutation helpers used by CLI subcommands
// ---------------------------------------------------------------------------

export type SetKeyInput = {
  filePath: string;
  name: string;
  key: keyof ProfileV1 | `credentials.${string}`;
  value: string | undefined; // undefined = unset
};

/** Apply a single-key edit to the user file. Re-validates the resulting profile
 *  before write — so e.g. `--key provider --value bogus` fails fast. */
export function setProfileKey(input: SetKeyInput): UserProfilesFile {
  validateProfileName(input.name);
  const existing = readUserFile(input.filePath) ?? { version: 1, profiles: {} };
  const current = existing.profiles[input.name] ?? { version: 1 };
  const next: Record<string, unknown> = { ...current };

  if (typeof input.key === "string" && input.key.startsWith("credentials.")) {
    const credKey = input.key.slice("credentials.".length);
    if (!credKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credKey)) {
      throw new SignCliError({
        code: "INVALID_PROFILE",
        message: `Invalid credentials key: ${JSON.stringify(credKey)}. Expected an env-var name like DROPBOX_SIGN_API_KEY.`,
      });
    }
    const nextCreds = { ...(current.credentials ?? {}) };
    if (input.value === undefined) {
      delete nextCreds[credKey];
    } else {
      nextCreds[credKey] = input.value;
    }
    next.credentials = Object.keys(nextCreds).length > 0 ? nextCreds : undefined;
  } else {
    const key = input.key as keyof ProfileV1;
    if (!VALID_PROFILE_KEYS.has(key as string) || key === "version") {
      throw new SignCliError({
        code: "INVALID_PROFILE",
        message: `Unknown profile key: ${JSON.stringify(key)}. Valid keys: ${Array.from(VALID_PROFILE_KEYS).filter((k) => k !== "version").join(", ")}.`,
      });
    }
    if (input.value === undefined) {
      delete next[key as string];
    } else {
      next[key as string] = coerceFieldValue(key, input.value);
    }
  }

  // Re-validate before persisting. This catches things like setting
  // provider=bogus or strictProvider=maybe at write time, not at run time.
  const validated = validateProfileShapeRaw(next, `<setProfileKey ${input.name}.${input.key}>`);
  existing.profiles[input.name] = validated;
  writeUserFile(input.filePath, existing);
  return existing;
}

function coerceFieldValue(key: keyof ProfileV1, raw: string): unknown {
  switch (key) {
    case "version": throw new SignCliError({ code: "INVALID_PROFILE", message: "version is read-only." });
    case "provider":
    case "dbPath":
    case "defaultSignerEmail":
      return raw;
    case "strictProvider": {
      const v = raw.trim().toLowerCase();
      if (v === "true") return true;
      if (v === "false") return false;
      throw new SignCliError({ code: "INVALID_PROFILE", message: `strictProvider must be true or false (got ${JSON.stringify(raw)}).` });
    }
    case "defaultTokenTtlMinutes": {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        throw new SignCliError({ code: "INVALID_PROFILE", message: `defaultTokenTtlMinutes must be a positive number.` });
      }
      return n;
    }
    case "credentials":
      throw new SignCliError({ code: "INVALID_PROFILE", message: "Use --key credentials.<NAME> to set an individual credential." });
  }
}

export type InitProfileInput = {
  filePath: string;
  name: string;
  values: Partial<ProfileV1>;
  setAsDefault?: boolean;
};

export function initUserProfile(input: InitProfileInput): UserProfilesFile {
  validateProfileName(input.name);
  const existing = readUserFile(input.filePath) ?? { version: 1, profiles: {} };
  if (existing.profiles[input.name]) {
    throw new SignCliError({
      code: "PROFILE_ALREADY_EXISTS",
      message: `A profile named '${input.name}' already exists in ${input.filePath}.`,
      hint: `Use \`sign profile delete --name ${input.name}\` first, or \`sign profile set\` to edit fields.`,
    });
  }
  const draft: Partial<ProfileV1> & { version: 1 } = { version: 1, ...input.values };
  const profile = validateProfileShapeRaw(draft, `<initUserProfile ${input.name}>`);
  existing.profiles[input.name] = profile;
  if (input.setAsDefault) existing.defaultProfile = input.name;
  writeUserFile(input.filePath, existing);
  return existing;
}

export function deleteUserProfile(filePath: string, name: string): UserProfilesFile {
  validateProfileName(name);
  const existing = readUserFile(filePath);
  if (!existing || !existing.profiles[name]) {
    throw new SignCliError({
      code: "PROFILE_NOT_FOUND",
      message: `No profile named '${name}' in ${filePath}.`,
    });
  }
  delete existing.profiles[name];
  if (existing.defaultProfile === name) delete existing.defaultProfile;
  writeUserFile(filePath, existing);
  return existing;
}

export function useUserProfile(filePath: string, name: string): UserProfilesFile {
  validateProfileName(name);
  const existing = readUserFile(filePath);
  if (!existing || !existing.profiles[name]) {
    throw new SignCliError({
      code: "PROFILE_NOT_FOUND",
      message: `No profile named '${name}' in ${filePath}.`,
      hint: existing
        ? `Available profiles: ${Object.keys(existing.profiles).sort().join(", ") || "(none)"}.`
        : `No user profile file exists yet.`,
    });
  }
  existing.defaultProfile = name;
  writeUserFile(filePath, existing);
  return existing;
}
