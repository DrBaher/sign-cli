import test from "node:test";
import assert from "node:assert/strict";
import { diffPolicies, renderPolicyDiffAsMarkdown } from "../lib/policy-diff.js";
import type { PolicySpec } from "../lib/policy-engine.js";

const BEFORE: PolicySpec = {
  rules: [
    { match: { titlePattern: "^NDA " }, action: "sign" },
    { match: "any", action: "report" },
  ],
};
const AFTER: PolicySpec = {
  rules: [
    { match: { titlePattern: "^NDA " }, action: "decline", reason: "no more autos" },
    { match: { signerEmail: "vip@example.com" }, action: "sign" },
    { match: "any", action: "report" },
  ],
};

test("renderPolicyDiffAsMarkdown produces a reviewer table with rollup + changed-first ordering", () => {
  const summary = diffPolicies(BEFORE, AFTER, [
    { requestId: "r-stable", title: "MSA Acme", documentSha256: "aa", signerEmail: "bob@example.com" },
    { requestId: "r-changed-1", title: "NDA Acme", documentSha256: "bb", signerEmail: "alice@example.com" },
    { requestId: "r-changed-2", title: "MSA", documentSha256: "cc", signerEmail: "vip@example.com" },
  ]);
  const md = renderPolicyDiffAsMarkdown(summary, {
    before: "./policy.v1.json",
    after: "./policy.v2.json",
  });
  // Header section.
  assert.match(md, /^# Policy diff/);
  assert.match(md, /policy\.v1\.json/);
  assert.match(md, /policy\.v2\.json/);
  assert.match(md, /total:\s+3/);
  assert.match(md, /changed:\s+\*\*2\*\*/);
  // Table separator line is present.
  assert.match(md, /\| changed \| requestId \|/);
  // Changed rows surface above the unchanged one.
  const lines = md.split("\n");
  const tableStart = lines.findIndex((l) => l.startsWith("|---"));
  assert.ok(tableStart > 0);
  const dataLines = lines.slice(tableStart + 1).filter((l) => l.startsWith("| "));
  // First two data rows are changed (✓), the last is unchanged.
  assert.match(dataLines[0], /\|\s+✓\s+\|/);
  assert.match(dataLines[1], /\|\s+✓\s+\|/);
  assert.match(dataLines[2], /\|\s+\s+\|/);
});

test("renderPolicyDiffAsMarkdown escapes pipes and backticks in titles to prevent table injection", () => {
  const summary = diffPolicies(BEFORE, AFTER, [
    { requestId: "r-evil", title: "title | with | pipes `and` ticks", documentSha256: "aa", signerEmail: "alice@example.com" },
  ]);
  const md = renderPolicyDiffAsMarkdown(summary, { before: "./b.json", after: "./a.json" });
  // Pipes escaped to \|; backticks escaped to \`.
  assert.ok(md.includes("title \\| with \\| pipes \\`and\\` ticks"));
});

test("renderPolicyDiffAsMarkdown handles an empty context list with a friendly placeholder", () => {
  const summary = diffPolicies(BEFORE, AFTER, []);
  const md = renderPolicyDiffAsMarkdown(summary, { before: "./b.json", after: "./a.json" });
  assert.match(md, /No contexts to diff/);
});
