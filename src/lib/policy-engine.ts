import { readFileSync } from "node:fs";
import path from "node:path";
import { SignCliError } from "./sign-error.js";

export type PolicyExpectations = {
  titleMatches?: string;
  documentSha256?: string;
  documentSha256Whitelist?: string[];
  signerEmail?: string;
};

export type PolicyRuleMatcher =
  | "any"
  | {
      titlePattern?: string;
      documentSha256?: string;
      signerEmail?: string;
    };

export type PolicyAction = "sign" | "decline" | "report";

export type PolicyRule = {
  match: PolicyRuleMatcher;
  action: PolicyAction;
  reason?: string;
};

export type PolicySpec = {
  version?: number;
  expectations?: PolicyExpectations;
  rules: PolicyRule[];
};

export type PolicyEvaluationContext = {
  title: string;
  documentSha256: string;
  signerEmail: string;
};

export type PolicyDecision = {
  action: PolicyAction;
  matchedRuleIndex: number | null;
  reason: string | null;
};

function policyError(message: string, details?: Record<string, unknown>): SignCliError {
  return new SignCliError({
    code: "INVALID_SPEC",
    message,
    hint: "See fixtures/signer-policy.example.json for a starting policy file.",
    details,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw policyError(`policy.${fieldName} must be a non-empty string.`);
  }
  return value;
}

function parseExpectations(input: unknown): PolicyExpectations | undefined {
  if (input === undefined) return undefined;
  if (!isObject(input)) throw policyError("policy.expectations must be an object.");
  const out: PolicyExpectations = {};
  if (input.titleMatches !== undefined) out.titleMatches = ensureString(input.titleMatches, "expectations.titleMatches");
  if (input.documentSha256 !== undefined) out.documentSha256 = ensureString(input.documentSha256, "expectations.documentSha256");
  if (input.documentSha256Whitelist !== undefined) {
    if (!Array.isArray(input.documentSha256Whitelist)) {
      throw policyError("policy.expectations.documentSha256Whitelist must be an array.");
    }
    out.documentSha256Whitelist = input.documentSha256Whitelist.map((entry, idx) =>
      ensureString(entry, `expectations.documentSha256Whitelist[${idx}]`));
  }
  if (input.signerEmail !== undefined) out.signerEmail = ensureString(input.signerEmail, "expectations.signerEmail");
  return out;
}

function parseRules(input: unknown): PolicyRule[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw policyError("policy.rules must be a non-empty array.");
  }
  return input.map((entry, idx) => {
    if (!isObject(entry)) throw policyError(`policy.rules[${idx}] must be an object.`);
    const action = entry.action;
    if (action !== "sign" && action !== "decline" && action !== "report") {
      throw policyError(`policy.rules[${idx}].action must be "sign", "decline", or "report".`);
    }
    const reason = entry.reason === undefined ? undefined : ensureString(entry.reason, `rules[${idx}].reason`);
    let match: PolicyRuleMatcher;
    if (entry.match === "any") {
      match = "any";
    } else if (isObject(entry.match)) {
      const m: { titlePattern?: string; documentSha256?: string; signerEmail?: string } = {};
      if (entry.match.titlePattern !== undefined) m.titlePattern = ensureString(entry.match.titlePattern, `rules[${idx}].match.titlePattern`);
      if (entry.match.documentSha256 !== undefined) m.documentSha256 = ensureString(entry.match.documentSha256, `rules[${idx}].match.documentSha256`);
      if (entry.match.signerEmail !== undefined) m.signerEmail = ensureString(entry.match.signerEmail, `rules[${idx}].match.signerEmail`);
      if (Object.keys(m).length === 0) {
        throw policyError(`policy.rules[${idx}].match must have at least one of titlePattern/documentSha256/signerEmail (or be the string "any").`);
      }
      match = m;
    } else {
      throw policyError(`policy.rules[${idx}].match must be "any" or an object.`);
    }
    return { match, action: action as PolicyAction, ...(reason ? { reason } : {}) };
  });
}

export function parsePolicySpec(raw: unknown): PolicySpec {
  if (!isObject(raw)) throw policyError("Policy spec must be a JSON object at the top level.");
  const expectations = parseExpectations(raw.expectations);
  const rules = parseRules(raw.rules);
  const version = raw.version === undefined
    ? undefined
    : (typeof raw.version === "number" && Number.isInteger(raw.version)
      ? raw.version
      : (() => { throw policyError("policy.version must be an integer when set."); })());
  return { ...(version !== undefined ? { version } : {}), ...(expectations ? { expectations } : {}), rules };
}

export function loadPolicySpec(filePath: string): PolicySpec {
  let raw: unknown;
  try {
    const text = readFileSync(filePath, "utf8");
    raw = JSON.parse(text);
  } catch (error) {
    throw new SignCliError({
      code: "INVALID_SPEC",
      message: `Failed to load policy spec from ${filePath}: ${(error as Error).message}`,
      details: { filePath: path.resolve(filePath) },
    });
  }
  return parsePolicySpec(raw);
}

export function applyPolicyExpectations(
  expectations: PolicyExpectations | undefined,
  ctx: PolicyEvaluationContext,
): void {
  if (!expectations) return;
  if (expectations.titleMatches) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(expectations.titleMatches);
    } catch (error) {
      throw new SignCliError({
        code: "INVALID_SPEC",
        message: `policy.expectations.titleMatches is not a valid regex: ${(error as Error).message}`,
      });
    }
    if (!pattern.test(ctx.title)) {
      throw new SignCliError({
        code: "POLICY_VIOLATION",
        message: `Policy expectation failed: title ${JSON.stringify(ctx.title)} does not match /${expectations.titleMatches}/.`,
        details: { title: ctx.title, expected: expectations.titleMatches },
      });
    }
  }
  if (expectations.documentSha256) {
    const want = expectations.documentSha256.trim().toLowerCase();
    const have = ctx.documentSha256.trim().toLowerCase();
    if (want !== have) {
      throw new SignCliError({
        code: "POLICY_VIOLATION",
        message: `Policy expectation failed: documentSha256 ${have} does not match expected ${want}.`,
        details: { expected: want, actual: have },
      });
    }
  }
  if (expectations.documentSha256Whitelist && expectations.documentSha256Whitelist.length > 0) {
    const have = ctx.documentSha256.trim().toLowerCase();
    const allow = expectations.documentSha256Whitelist.map((e) => e.trim().toLowerCase());
    if (!allow.includes(have)) {
      throw new SignCliError({
        code: "POLICY_VIOLATION",
        message: `Policy expectation failed: documentSha256 ${have} is not in the whitelist (${allow.length} entries).`,
        details: { actual: have, whitelist: allow },
      });
    }
  }
  if (expectations.signerEmail) {
    const want = expectations.signerEmail.trim().toLowerCase();
    const have = ctx.signerEmail.trim().toLowerCase();
    if (want !== have) {
      throw new SignCliError({
        code: "POLICY_VIOLATION",
        message: `Policy expectation failed: signerEmail ${have} does not match expected ${want}.`,
        details: { expected: want, actual: have },
      });
    }
  }
}

function ruleMatches(rule: PolicyRule, ctx: PolicyEvaluationContext): boolean {
  if (rule.match === "any") return true;
  const { titlePattern, documentSha256, signerEmail } = rule.match;
  if (titlePattern) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(titlePattern);
    } catch {
      return false;
    }
    if (!pattern.test(ctx.title)) return false;
  }
  if (documentSha256) {
    if (documentSha256.trim().toLowerCase() !== ctx.documentSha256.trim().toLowerCase()) return false;
  }
  if (signerEmail) {
    if (signerEmail.trim().toLowerCase() !== ctx.signerEmail.trim().toLowerCase()) return false;
  }
  return true;
}

export function evaluatePolicy(spec: PolicySpec, ctx: PolicyEvaluationContext): PolicyDecision {
  applyPolicyExpectations(spec.expectations, ctx);
  for (let i = 0; i < spec.rules.length; i += 1) {
    const rule = spec.rules[i];
    if (ruleMatches(rule, ctx)) {
      return {
        action: rule.action,
        matchedRuleIndex: i,
        reason: rule.reason ?? null,
      };
    }
  }
  return {
    action: "decline",
    matchedRuleIndex: null,
    reason: "No matching policy rule; defaulting to decline.",
  };
}
