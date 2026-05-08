#!/usr/bin/env node
// Print a Keep-a-Changelog-shaped block for commits since the last tag.
// Use to seed CHANGELOG.md's [Unreleased] section before a release.
//
//   node scripts/changelog.mjs                # since most recent tag
//   node scripts/changelog.mjs v0.4.0         # since a specific tag
//
// Conventional-commit prefixes map to Keep-a-Changelog sections:
//   feat:     → ### Added
//   fix:      → ### Fixed
//   refactor: → ### Refactor
//   docs:     → ### Docs
//   chore:    → ### Chore
// Anything else falls into ### Changed.

import { execSync } from "node:child_process";

function git(cmd) {
  return execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
}

const explicitTag = process.argv[2];
let baseRef;
try {
  baseRef = explicitTag ?? git("describe --tags --abbrev=0");
} catch {
  baseRef = git("rev-list --max-parents=0 HEAD"); // root commit
  process.stderr.write(`(no tags yet — using root commit ${baseRef.slice(0, 8)})\n`);
}

const log = git(`log --no-merges --pretty=format:%s ${baseRef}..HEAD`);
const lines = log.split("\n").filter(Boolean);
if (lines.length === 0) {
  process.stderr.write(`No commits since ${baseRef}.\n`);
  process.exit(0);
}

const buckets = {
  Added: [],
  Fixed: [],
  Changed: [],
  Refactor: [],
  Docs: [],
  Chore: [],
};

for (const line of lines) {
  // Strip optional scope: feat(scope): or feat:
  const match = line.match(/^(feat|fix|refactor|docs|chore)(?:\([^)]*\))?:\s+(.+)$/i);
  if (match) {
    const type = match[1].toLowerCase();
    const summary = match[2];
    const section = {
      feat: "Added",
      fix: "Fixed",
      refactor: "Refactor",
      docs: "Docs",
      chore: "Chore",
    }[type];
    buckets[section].push(`- ${summary}`);
  } else {
    buckets.Changed.push(`- ${line}`);
  }
}

const out = [`## [Unreleased]`, ""];
for (const section of ["Added", "Fixed", "Changed", "Refactor", "Docs", "Chore"]) {
  if (buckets[section].length === 0) continue;
  out.push(`### ${section}`, "", ...buckets[section], "");
}
process.stdout.write(out.join("\n"));
