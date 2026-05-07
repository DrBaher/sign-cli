// Policy A/B diff. Lets agents preview the impact of a policy change before
// running `signer policy run-all` against real requests: feed two specs +
// a set of contexts (either a snapshot or every pending inbox row) and get
// back side-by-side decisions plus a list of rows whose action would flip.

import { evaluatePolicy, type PolicyDecision, type PolicySpec } from "./policy-engine.js";

export type PolicyDiffContext = {
  requestId: string | null;
  title: string;
  documentSha256: string;
  signerEmail: string;
};

export type PolicyDiffRow = {
  ctx: PolicyDiffContext;
  before: PolicyDecision;
  after: PolicyDecision;
  changed: boolean;
};

export type PolicyDiffSummary = {
  total: number;
  changed: number;
  unchanged: number;
  results: PolicyDiffRow[];
  // Counts of "changed" rows broken down by what the action flipped to under `after`.
  flipped: { sign: number; decline: number; report: number };
};

// Two decisions are "equal" for the diff if their action matches. Same outcome,
// different rule index/reason is not behaviorally different — surfacing it would
// drown the meaningful signal (action flips) in policy-cleanup noise.
function decisionsEqual(a: PolicyDecision, b: PolicyDecision): boolean {
  return a.action === b.action;
}

export function diffPolicies(
  before: PolicySpec,
  after: PolicySpec,
  contexts: PolicyDiffContext[],
): PolicyDiffSummary {
  const results: PolicyDiffRow[] = [];
  const flipped = { sign: 0, decline: 0, report: 0 };
  let changedCount = 0;
  for (const ctx of contexts) {
    const evalCtx = {
      title: ctx.title,
      documentSha256: ctx.documentSha256,
      signerEmail: ctx.signerEmail,
    };
    const beforeDecision = safeEvaluate(before, evalCtx);
    const afterDecision = safeEvaluate(after, evalCtx);
    const changed = !decisionsEqual(beforeDecision, afterDecision);
    if (changed) {
      changedCount += 1;
      flipped[afterDecision.action] += 1;
    }
    results.push({ ctx, before: beforeDecision, after: afterDecision, changed });
  }
  return {
    total: contexts.length,
    changed: changedCount,
    unchanged: contexts.length - changedCount,
    results,
    flipped,
  };
}

// `applyPolicyExpectations` (called inside `evaluatePolicy`) throws POLICY_VIOLATION
// when a hard expectation fails; for a diff we want to record that as an outcome,
// not abort the whole comparison. Treat those throws as a synthetic "decline" so
// the row still appears side-by-side.
function safeEvaluate(
  spec: PolicySpec,
  ctx: { title: string; documentSha256: string; signerEmail: string },
): PolicyDecision {
  try {
    return evaluatePolicy(spec, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      action: "decline",
      matchedRuleIndex: null,
      reason: `expectation failed: ${message}`,
    };
  }
}
