import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalogJson,
  EXAMPLE_WALKTHROUGHS,
  findCommand,
  formatCommandHelp,
  formatExamples,
  formatTopLevelHelp,
  HELP_CATALOG,
  SIGN_CLI_VERSION,
} from "../lib/help-catalog.js";

test("HELP_CATALOG entries all have unique commands and non-empty summaries", () => {
  const seen = new Set<string>();
  for (const entry of HELP_CATALOG) {
    assert.equal(seen.has(entry.command), false, `duplicate entry: ${entry.command}`);
    seen.add(entry.command);
    assert.equal(typeof entry.summary, "string");
    assert.ok(entry.summary.length > 0);
  }
});

test("findCommand resolves both single-word and multi-word commands", () => {
  assert.ok(findCommand("init"));
  assert.ok(findCommand("request create"));
  assert.ok(findCommand("signer policy run-all"));
  assert.equal(findCommand("nope"), null);
  assert.equal(findCommand("request nope"), null);
});

test("formatTopLevelHelp prints headline + grouped buckets + the discoverability hint", () => {
  const out = formatTopLevelHelp();
  assert.match(out, /^sign — consent-gated/);
  assert.match(out, /# request/);
  assert.match(out, /# signer/);
  assert.match(out, /sign --catalog json/);
  assert.match(out, /sign request create/);
});

test("formatCommandHelp renders flags with required tags and an example block", () => {
  const sign = findCommand("sign")!;
  const out = formatCommandHelp(sign);
  assert.match(out, /sign sign/);
  assert.match(out, /--token/);
  assert.match(out, /\(required\)/);
  assert.match(out, /Example:/);
});

test("buildCatalogJson is machine-readable and matches HELP_CATALOG entries 1:1", () => {
  const catalog = buildCatalogJson();
  assert.equal(catalog.commands.length, HELP_CATALOG.length);
  // Round-trip through JSON to verify there are no functions/symbols leaking through.
  const roundTripped = JSON.parse(JSON.stringify(catalog));
  assert.equal(roundTripped.commands.length, HELP_CATALOG.length);
  // Each entry has at least command + summary.
  for (const cmd of catalog.commands) {
    assert.equal(typeof cmd.command, "string");
    assert.equal(typeof cmd.summary, "string");
  }
});

test("buildCatalogJson includes the CLI version (matches the shape agent-guide §3 documents)", async () => {
  const { SIGN_CLI_VERSION } = await import("../lib/help-catalog.js");
  const catalog = buildCatalogJson();
  assert.equal(catalog.version, SIGN_CLI_VERSION);
  assert.match(catalog.version, /^\d+\.\d+\.\d+/);
});

test("formatExamples covers the canonical flows agents and humans care about", () => {
  const out = formatExamples();
  for (const expected of [
    "Local-provider sanity check",
    "Two-signer NDA, agent-as-signer",
    "Declarative policy enforcement",
    "Cryptographic receipt for compliance",
    "MCP server for an LLM agent",
  ]) {
    assert.match(out, new RegExp(expected.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));
  }
});

test("EXAMPLE_WALKTHROUGHS each have a non-empty title and at least one command", () => {
  assert.ok(EXAMPLE_WALKTHROUGHS.length > 0);
  for (const example of EXAMPLE_WALKTHROUGHS) {
    assert.ok(example.title.length > 0);
    assert.ok(example.commands.length > 0);
  }
});

test("SIGN_CLI_VERSION matches semver shape", () => {
  assert.match(SIGN_CLI_VERSION, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
});
