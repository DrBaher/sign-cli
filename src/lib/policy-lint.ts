// Static checks for a policy spec. Pure / read-only — no network, no DB, no
// state mutation. Catches the four classes of mistake we've seen in real
// specs:
//
//  1. Invalid regex in `titlePattern` or `expectations.titleMatches`.
//  2. Unreachable rules (anything after a `match: "any"` rule never fires).
//  3. Redundant rules (rule N is a strict subset of an earlier rule with the
//     same action — it can never produce a different decision).
//  4. `decline` actions without a `reason` (signer-facing, leaves the signer
//     guessing; we don't FAIL on this — it's a warning).
//
// Output is structured: `{ ok, errors[], warnings[] }` so the CLI handler can
// exit non-zero on errors but stay zero when only warnings fire.

import type { PolicyRule, PolicySpec } from "./policy-engine.js";

export type PolicyLintFinding = {
  severity: "error" | "warning";
  code:
    | "INVALID_REGEX"
    | "UNREACHABLE_RULE"
    | "REDUNDANT_RULE"
    | "DECLINE_WITHOUT_REASON"
    | "EMPTY_RULES";
  ruleIndex: number | null;
  message: string;
};

export type PolicyLintReport = {
  ok: boolean;
  errors: PolicyLintFinding[];
  warnings: PolicyLintFinding[];
};

function tryCompileRegex(pattern: string): { ok: true } | { ok: false; error: string } {
  try {
    new RegExp(pattern);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// rule B is "covered by" rule A if every match A makes, B would also make
// — i.e. A is a more general/identical predicate. Conservative: only flag
// the cases we're certain about.
function ruleAImpliesB(a: PolicyRule, b: PolicyRule): boolean {
  if (a.match === "any") return true;
  if (b.match === "any") return false;
  // Both are object matchers. A implies B when every constraint A puts on the
  // context is *also* satisfied (or unconstrained) by B's matcher.
  const am = a.match;
  const bm = b.match;
  // A's titlePattern absent → no constraint; A's titlePattern present → B must
  // have the same pattern (we don't try to do regex-language inclusion).
  if (am.titlePattern && am.titlePattern !== bm.titlePattern) return false;
  if (am.documentSha256 && am.documentSha256 !== bm.documentSha256) return false;
  if (am.signerEmail && am.signerEmail !== bm.signerEmail) return false;
  return true;
}

export function lintPolicySpec(spec: PolicySpec): PolicyLintReport {
  const errors: PolicyLintFinding[] = [];
  const warnings: PolicyLintFinding[] = [];

  if (!spec.rules || spec.rules.length === 0) {
    errors.push({
      severity: "error",
      code: "EMPTY_RULES",
      ruleIndex: null,
      message: "policy.rules is empty; the engine will fall through to the default decline.",
    });
    return { ok: false, errors, warnings };
  }

  // Top-level expectations.titleMatches regex.
  if (spec.expectations?.titleMatches) {
    const result = tryCompileRegex(spec.expectations.titleMatches);
    if (!result.ok) {
      errors.push({
        severity: "error",
        code: "INVALID_REGEX",
        ruleIndex: null,
        message: `expectations.titleMatches is not a valid regex: ${result.error}`,
      });
    }
  }

  let firstAnyIndex: number | null = null;
  for (let i = 0; i < spec.rules.length; i += 1) {
    const rule = spec.rules[i];

    // Per-rule regex check.
    if (rule.match !== "any" && rule.match.titlePattern) {
      const result = tryCompileRegex(rule.match.titlePattern);
      if (!result.ok) {
        errors.push({
          severity: "error",
          code: "INVALID_REGEX",
          ruleIndex: i,
          message: `rules[${i}].match.titlePattern is not a valid regex: ${result.error}`,
        });
      }
    }

    if (firstAnyIndex !== null) {
      warnings.push({
        severity: "warning",
        code: "UNREACHABLE_RULE",
        ruleIndex: i,
        message: `rules[${i}] is unreachable: rules[${firstAnyIndex}] uses match: "any" and consumes everything.`,
      });
    } else if (rule.match === "any") {
      firstAnyIndex = i;
    }

    // Decline without a reason: signer can't tell why.
    if (rule.action === "decline" && !rule.reason) {
      warnings.push({
        severity: "warning",
        code: "DECLINE_WITHOUT_REASON",
        ruleIndex: i,
        message: `rules[${i}] declines without a reason; the signer will see a generic message.`,
      });
    }

    // Redundancy: an earlier rule with the same action that already covers this matcher.
    for (let j = 0; j < i; j += 1) {
      const earlier = spec.rules[j];
      if (earlier.action !== rule.action) continue;
      if (ruleAImpliesB(earlier, rule)) {
        warnings.push({
          severity: "warning",
          code: "REDUNDANT_RULE",
          ruleIndex: i,
          message: `rules[${i}] is redundant: rules[${j}] (action="${earlier.action}") already covers it.`,
        });
        break;
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
