#!/usr/bin/env node
// Extracts the section of CHANGELOG.md for a given tag (v0.5.0 → "## [0.5.0]")
// and prints it to stdout. Used by .github/workflows/release.yml to populate
// the GitHub Release body. Exits 0 even if the section is missing — the
// workflow then falls back to auto-generated notes.

import { readFileSync } from "node:fs";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: extract-changelog.mjs <tag>");
  process.exit(64);
}
const version = tag.replace(/^v/u, "");
const text = readFileSync(process.argv[3] ?? "CHANGELOG.md", "utf8");

const lines = text.split("\n");
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  process.stderr.write(`No CHANGELOG section found for ${version}\n`);
  process.exit(0);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (/^## /u.test(lines[i])) {
    end = i;
    break;
  }
}

process.stdout.write(lines.slice(start, end).join("\n").trim() + "\n");
