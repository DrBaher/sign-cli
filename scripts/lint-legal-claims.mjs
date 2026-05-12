#!/usr/bin/env node
// Scans user-facing docs + landing page for legal claims that exceed what
// docs/legal-posture.md says we'll defend. Prevents accidental drift —
// e.g., a future README edit that says "eIDAS-compliant" or
// "legally binding" without a jurisdiction qualifier.
//
// Run standalone:   node scripts/lint-legal-claims.mjs
// Run from npm:     npm run lint:legal-claims
// Also exercised by src/tests/lint-legal-claims.test.ts so CI catches it.
//
// What this is NOT: a substitute for thinking. Adding patterns here is
// easy; the harder discipline is to read the legal-posture doc before
// editing marketing copy. The lint is a backstop, not the rule.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Patterns we consider unsafe in user-facing copy. `nearby` is an optional
// follow-up word/phrase that, if found within ~80 characters of the match,
// turns the match into an acceptable qualified claim (e.g., "legally
// binding under US ESIGN").
const FORBIDDEN_PATTERNS = [
  {
    name: "unqualified 'legally binding'",
    pattern: /\blegally[- ]binding\b/giu,
    qualifier: /\b(under|in|for|when)\b/i,
    hint: "Add a jurisdiction qualifier (e.g., 'legally binding under US ESIGN/UETA').",
  },
  {
    name: "eIDAS-compliant claim",
    pattern: /\beIDAS[- ]?compliant\b/giu,
    hint: "We produce a Simple Electronic Signature admissible under eIDAS Article 25(1) — not 'eIDAS-compliant' as a whole. Rephrase or move the discussion to docs/legal-posture.md.",
  },
  {
    name: "AdES-compliant claim",
    pattern: /\bAdES[- ]?compliant\b/giu,
    hint: "Self-issued certs don't meet AdES's 'uniquely linked to signer' requirement. Don't claim AdES.",
  },
  {
    name: "court-ready claim",
    pattern: /\bcourt[- ]ready\b/giu,
    hint: "Court-readiness depends on jurisdiction + counterparty. Phrase as 'admissible' or 'defensible' with context.",
  },
  {
    name: "replaces-wet-signature claim",
    pattern: /\b(replaces?|substitutes? for) wet[- ]?(ink )?signatures?\b/giu,
    hint: "Only QES is the legal equivalent of wet ink under eIDAS. Don't claim wet-signature equivalence.",
  },
  {
    name: "equivalent-to-wet-signature claim",
    pattern: /\b(legal )?equivalent (of|to) (a |the )?(handwritten|wet[- ]?ink|wet) signature/giu,
    hint: "Only QES is the legal equivalent of wet ink under eIDAS. Don't claim wet-signature equivalence.",
  },
  {
    name: "qualified-electronic-signature claim",
    pattern: /\bproduces? (a )?qualified electronic signature/giu,
    hint: "We do NOT produce a QES. Rephrase. Discussing QES (e.g., explaining what it is) is fine; claiming to produce one is not.",
  },
];

// Files that are exempted because they're the authoritative source for the
// nuance (legal-posture.md), historical record (CHANGELOG), or not
// user-facing copy.
const EXEMPT_FILES = new Set([
  "docs/legal-posture.md",
  "CHANGELOG.md",
]);

// Directories we explicitly DO scan (relative to repo root). Files inside
// these dirs are scanned if they match SCAN_FILE_EXTS and aren't exempt.
const SCAN_DIRS = ["docs", "deploy", "fixtures/web-demo"];

const SCAN_FILE_EXTS = new Set([".md", ".html"]);

// Top-level files we always scan (when they exist).
const SCAN_TOP_LEVEL = [
  "README.md",
  "ONBOARDING.md",
  "PROVIDER_SELECTION.md",
  "CHECKLIST.md",
  "TROUBLESHOOTING.md",
  "DISTRIBUTION.md",
  "MIGRATION.md",
  "RELEASE.md",
  "SIGNWELL_SETUP.md",
  "EMBEDDED_SETUP.md",
];

function walk(dir, acc = []) {
  if (!statSyncSafe(dir)?.isDirectory()) return acc;
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const stat = statSyncSafe(abs);
    if (!stat) continue;
    if (stat.isDirectory()) {
      walk(abs, acc);
    } else if (stat.isFile() && SCAN_FILE_EXTS.has(path.extname(entry).toLowerCase())) {
      acc.push(abs);
    }
  }
  return acc;
}

function statSyncSafe(p) {
  try { return statSync(p); } catch { return null; }
}

function collectScanTargets(repoRoot) {
  const files = new Set();
  for (const f of SCAN_TOP_LEVEL) {
    const abs = path.join(repoRoot, f);
    if (statSyncSafe(abs)) files.add(abs);
  }
  for (const d of SCAN_DIRS) {
    walk(path.join(repoRoot, d), Array.from(files)).forEach((f) => files.add(f));
  }
  const exempt = new Set([...EXEMPT_FILES].map((f) => path.join(repoRoot, f)));
  return [...files].filter((f) => !exempt.has(f)).sort();
}

function lineNumberAt(content, index) {
  let n = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") n += 1;
  }
  return n;
}

function isQualified(content, matchIndex, matchLength, qualifier) {
  if (!qualifier) return false;
  // Look ±80 chars around the match for the qualifier.
  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(content.length, matchIndex + matchLength + 80);
  return qualifier.test(content.slice(start, end));
}

/**
 * Scan the configured doc/landing-page surface for forbidden legal claims.
 * Returns an array of violations; empty array = clean.
 */
export function lintLegalClaims(repoRoot = REPO_ROOT) {
  const violations = [];
  for (const file of collectScanTargets(repoRoot)) {
    const content = readFileSync(file, "utf8");
    for (const rule of FORBIDDEN_PATTERNS) {
      // Reset the regex's lastIndex — these are /g and we use exec in a loop.
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(content)) !== null) {
        if (isQualified(content, m.index, m[0].length, rule.qualifier)) continue;
        violations.push({
          file: path.relative(repoRoot, file),
          line: lineNumberAt(content, m.index),
          rule: rule.name,
          match: m[0],
          hint: rule.hint,
        });
      }
    }
  }
  return violations;
}

function formatViolation(v) {
  return `  ${v.file}:${v.line}  [${v.rule}]  matched "${v.match}"\n    → ${v.hint}`;
}

// CLI entrypoint — only runs when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = lintLegalClaims();
  if (violations.length === 0) {
    console.log(`[lint:legal-claims] clean — scanned ${collectScanTargets(REPO_ROOT).length} files.`);
    process.exit(0);
  }
  console.error(`[lint:legal-claims] ${violations.length} violation(s) found:\n`);
  for (const v of violations) console.error(formatViolation(v));
  console.error(`\nSee docs/legal-posture.md → "What we'll never claim" for the rationale.`);
  console.error(`If a match is legitimate, either rephrase, add a jurisdiction qualifier, or`);
  console.error(`move the discussion into docs/legal-posture.md (which is exempt from the lint).`);
  process.exit(1);
}
