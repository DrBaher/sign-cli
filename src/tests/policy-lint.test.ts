import test from "node:test";
import assert from "node:assert/strict";
import { lintPolicySpec } from "../lib/policy-lint.js";
import type { PolicySpec } from "../lib/policy-engine.js";

test("lintPolicySpec passes a clean spec", () => {
  const spec: PolicySpec = {
    rules: [
      { match: { titlePattern: "^NDA " }, action: "sign" },
      { match: { signerEmail: "vip@example.com" }, action: "sign" },
      { match: "any", action: "decline", reason: "default-deny" },
    ],
  };
  const report = lintPolicySpec(spec);
  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
});

test("lintPolicySpec flags an empty rules array as an error", () => {
  const report = lintPolicySpec({ rules: [] });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].code, "EMPTY_RULES");
});

test("lintPolicySpec catches invalid regex in titlePattern + expectations", () => {
  const spec: PolicySpec = {
    expectations: { titleMatches: "(unbalanced" },
    rules: [
      { match: { titlePattern: "[also-bad" }, action: "sign" },
      { match: "any", action: "report" },
    ],
  };
  const report = lintPolicySpec(spec);
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 2);
  assert.equal(report.errors.every((e) => e.code === "INVALID_REGEX"), true);
});

test("lintPolicySpec warns about rules unreachable after a match: \"any\"", () => {
  const spec: PolicySpec = {
    rules: [
      { match: "any", action: "sign" },
      { match: { titlePattern: "^NDA " }, action: "decline", reason: "block NDAs" },
    ],
  };
  const report = lintPolicySpec(spec);
  assert.equal(report.ok, true); // warnings only
  const unreachable = report.warnings.filter((w) => w.code === "UNREACHABLE_RULE");
  assert.equal(unreachable.length, 1);
  assert.equal(unreachable[0].ruleIndex, 1);
});

test("lintPolicySpec warns about a redundant rule covered by an earlier same-action rule", () => {
  const spec: PolicySpec = {
    rules: [
      { match: { signerEmail: "vip@example.com" }, action: "sign" },
      { match: { signerEmail: "vip@example.com", titlePattern: "^NDA " }, action: "sign" },
      { match: "any", action: "report" },
    ],
  };
  const report = lintPolicySpec(spec);
  const redundant = report.warnings.filter((w) => w.code === "REDUNDANT_RULE");
  assert.equal(redundant.length, 1);
  assert.equal(redundant[0].ruleIndex, 1);
});

test("lintPolicySpec warns when a decline rule lacks a reason", () => {
  const spec: PolicySpec = {
    rules: [
      { match: { titlePattern: "^Risky " }, action: "decline" },
      { match: "any", action: "report" },
    ],
  };
  const report = lintPolicySpec(spec);
  const noReason = report.warnings.filter((w) => w.code === "DECLINE_WITHOUT_REASON");
  assert.equal(noReason.length, 1);
  assert.equal(noReason[0].ruleIndex, 0);
});

test("lintPolicySpec does not flag rules with the same matcher but different actions as redundant", () => {
  const spec: PolicySpec = {
    rules: [
      { match: { signerEmail: "alice@example.com" }, action: "report" },
      { match: { signerEmail: "alice@example.com" }, action: "sign" }, // different action — fine
      { match: "any", action: "report" },
    ],
  };
  const report = lintPolicySpec(spec);
  assert.equal(report.warnings.filter((w) => w.code === "REDUNDANT_RULE").length, 0);
});

test("lintPolicySpec flags two rules with overlapping matchers but different actions as CONTRADICTORY_RULES (error, not warning)", () => {
  const spec: PolicySpec = {
    rules: [
      { match: { signerEmail: "vip@example.com" }, action: "sign" },
      // Same matcher, different action — engine picks the first; the second is dead.
      { match: { signerEmail: "vip@example.com" }, action: "decline", reason: "stale" },
      { match: "any", action: "report" },
    ],
  };
  const report = lintPolicySpec(spec);
  assert.equal(report.ok, false);
  const contradictions = report.errors.filter((e) => e.code === "CONTRADICTORY_RULES");
  assert.equal(contradictions.length, 1);
  assert.equal(contradictions[0].ruleIndex, 1);
  assert.match(contradictions[0].message, /unreachable/);
});

test("lintPolicySpec doesn't double-flag a rule that's both unreachable (after match: any) AND would otherwise contradict — UNREACHABLE_RULE wins as the cleaner diagnostic", () => {
  const spec: PolicySpec = {
    rules: [
      { match: "any", action: "sign" },
      { match: { titlePattern: "^NDA " }, action: "decline", reason: "block" },
    ],
  };
  const report = lintPolicySpec(spec);
  // UNREACHABLE_RULE warning fires for rules[1]; CONTRADICTORY_RULES does NOT
  // — we don't want two diagnostics for the same root cause.
  assert.ok(report.warnings.some((w) => w.code === "UNREACHABLE_RULE" && w.ruleIndex === 1));
  assert.equal(report.errors.filter((e) => e.code === "CONTRADICTORY_RULES").length, 0);
});

test("lintPolicySpec keeps reporting REDUNDANT_RULE as a warning when the earlier rule has the SAME action (no contradiction)", () => {
  const spec: PolicySpec = {
    rules: [
      { match: { signerEmail: "vip@example.com" }, action: "sign" },
      { match: { signerEmail: "vip@example.com", titlePattern: "^NDA " }, action: "sign" },
      { match: "any", action: "report" },
    ],
  };
  const report = lintPolicySpec(spec);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => w.code === "REDUNDANT_RULE"));
  assert.equal(report.errors.filter((e) => e.code === "CONTRADICTORY_RULES").length, 0);
});
