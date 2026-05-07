import test from "node:test";
import assert from "node:assert/strict";
import { diffPolicies, type PolicyDiffContext } from "../lib/policy-diff.js";
import type { PolicySpec } from "../lib/policy-engine.js";

const before: PolicySpec = {
  rules: [
    { match: { titlePattern: "^NDA " }, action: "sign", reason: "auto-approve NDAs" },
    { match: "any", action: "report" },
  ],
};

const after: PolicySpec = {
  rules: [
    { match: { titlePattern: "^NDA " }, action: "decline", reason: "no more auto NDAs" },
    { match: { signerEmail: "vip@example.com" }, action: "sign" },
    { match: "any", action: "report" },
  ],
};

const contexts: PolicyDiffContext[] = [
  { requestId: "r1", title: "NDA Acme", documentSha256: "aa", signerEmail: "alice@example.com" },
  { requestId: "r2", title: "MSA Acme", documentSha256: "bb", signerEmail: "vip@example.com" },
  { requestId: "r3", title: "Other", documentSha256: "cc", signerEmail: "bob@example.com" },
];

test("diffPolicies flags rows whose action flips and counts buckets", () => {
  const summary = diffPolicies(before, after, contexts);
  assert.equal(summary.total, 3);
  assert.equal(summary.changed, 2);
  assert.equal(summary.unchanged, 1);
  // r1 flipped sign → decline; r2 flipped report → sign; r3 stays report.
  assert.equal(summary.flipped.sign, 1);
  assert.equal(summary.flipped.decline, 1);
  assert.equal(summary.flipped.report, 0);
  const r1 = summary.results.find((r) => r.ctx.requestId === "r1")!;
  assert.equal(r1.before.action, "sign");
  assert.equal(r1.after.action, "decline");
  assert.equal(r1.changed, true);
  const r3 = summary.results.find((r) => r.ctx.requestId === "r3")!;
  assert.equal(r3.before.action, "report");
  assert.equal(r3.after.action, "report");
  assert.equal(r3.changed, false);
});

test("diffPolicies treats expectation failures as decline so the row is still recorded", () => {
  const strict: PolicySpec = {
    expectations: { signerEmail: "only-this@example.com" },
    rules: [{ match: "any", action: "sign" }],
  };
  const lenient: PolicySpec = {
    rules: [{ match: "any", action: "sign" }],
  };
  const summary = diffPolicies(strict, lenient, [
    { requestId: "r1", title: "Anything", documentSha256: "aa", signerEmail: "someone@else.com" },
  ]);
  assert.equal(summary.total, 1);
  assert.equal(summary.changed, 1);
  assert.equal(summary.results[0].before.action, "decline");
  assert.match(summary.results[0].before.reason ?? "", /expectation failed/);
  assert.equal(summary.results[0].after.action, "sign");
});

test("diffPolicies returns an empty summary for an empty context list", () => {
  const summary = diffPolicies(before, after, []);
  assert.equal(summary.total, 0);
  assert.equal(summary.changed, 0);
  assert.equal(summary.unchanged, 0);
  assert.deepEqual(summary.results, []);
  assert.deepEqual(summary.flipped, { sign: 0, decline: 0, report: 0 });
});
