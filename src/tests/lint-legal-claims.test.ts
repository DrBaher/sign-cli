import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Dynamic-import the .mjs lint script so we don't need a separate TS build path.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "..", "..", "scripts", "lint-legal-claims.mjs");
const { lintLegalClaims } = await import(scriptPath);

const REPO_ROOT = path.resolve(__dirname, "..", "..");

test("lint:legal-claims passes on the current repo", () => {
  const violations = lintLegalClaims(REPO_ROOT);
  if (violations.length > 0) {
    const formatted = violations.map((v: {
      file: string; line: number; rule: string; match: string; hint: string;
    }) => `  ${v.file}:${v.line}  [${v.rule}]  matched "${v.match}"\n    → ${v.hint}`).join("\n");
    assert.fail(
      `Expected zero legal-claim violations in the current repo, got ${violations.length}:\n${formatted}\n\n` +
      `See docs/reference/legal.md → "What we'll never claim" for the rationale.`,
    );
  }
});

test("lint:legal-claims catches each forbidden pattern in a fixture repo", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lint-legal-fixture-"));
  try {
    mkdirSync(path.join(tmp, "docs", "reference"), { recursive: true });
    // README contains one violation per rule. The lint should flag all of them.
    writeFileSync(path.join(tmp, "README.md"), [
      "Produces a legally binding signature.",                 // unqualified legally-binding
      "This tool is eIDAS-compliant out of the box.",          // eIDAS claim
      "Fully AdES compliant.",                                  // AdES claim
      "Court-ready audit trail.",                              // court-ready
      "Replaces wet signatures in your workflow.",             // wet-sig replacement
      "Legal equivalent of a handwritten signature.",          // wet-sig equivalence
      "Produces a qualified electronic signature.",            // QES claim
    ].join("\n\n"), "utf8");
    // docs/reference/legal.md is exempt — its mentions of forbidden phrases shouldn't count.
    writeFileSync(path.join(tmp, "docs", "reference", "legal.md"),
      "We never claim eIDAS-compliant, court-ready, or legally binding signatures.", "utf8");

    const violations = lintLegalClaims(tmp);
    const rulesHit = new Set(violations.map((v: { rule: string }) => v.rule));
    const expectedRules = [
      "unqualified 'legally binding'",
      "eIDAS-compliant claim",
      "AdES-compliant claim",
      "court-ready claim",
      "replaces-wet-signature claim",
      "equivalent-to-wet-signature claim",
      "qualified-electronic-signature claim",
    ];
    for (const rule of expectedRules) {
      assert.ok(rulesHit.has(rule), `expected rule "${rule}" to fire, didn't. fired: ${[...rulesHit].join(", ") || "(none)"}`);
    }
    // legal.md is exempt — none of its hits should appear.
    const fromExempt = violations.filter((v: { file: string }) => v.file.includes("legal.md"));
    assert.equal(fromExempt.length, 0, `legal.md is exempt; got ${fromExempt.length} hits from it`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("lint:legal-claims accepts 'legally binding under <jurisdiction>' as qualified", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "lint-legal-qualified-"));
  try {
    writeFileSync(path.join(tmp, "README.md"),
      "Signatures are legally binding under US ESIGN/UETA for most agreements.",
      "utf8");
    const violations = lintLegalClaims(tmp);
    const legallyBindingHits = violations.filter((v: { rule: string }) =>
      v.rule === "unqualified 'legally binding'");
    assert.equal(legallyBindingHits.length, 0,
      `expected the 'under US ESIGN' qualifier to suppress the legally-binding rule, got ${legallyBindingHits.length} hits`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
