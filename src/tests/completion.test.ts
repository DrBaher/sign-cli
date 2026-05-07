import test from "node:test";
import assert from "node:assert/strict";
import {
  generateBashCompletion,
  generateCompletionScript,
  generateFishCompletion,
  generateZshCompletion,
} from "../lib/completion.js";

test("generateBashCompletion emits a complete -F binding for `sign`", () => {
  const out = generateBashCompletion();
  assert.match(out, /complete -F _sign_completion sign/);
  assert.match(out, /_sign_completion\(\)/);
  // Sanity: includes a known root and a known flag
  assert.match(out, /signer/);
  assert.match(out, /--token/);
  assert.match(out, /--provider/);
  // Provider values should appear so completion of --provider works
  assert.match(out, /dropbox/);
});

test("generateZshCompletion emits a compdef binding", () => {
  const out = generateZshCompletion();
  assert.match(out, /compdef _sign sign/);
  assert.match(out, /_sign\(\)/);
  // Subs catalog sanity
  assert.match(out, /signer/);
  assert.match(out, /--tokens-file/);
});

test("generateFishCompletion emits complete -c sign for roots, subs, and known flags", () => {
  const out = generateFishCompletion();
  assert.match(out, /complete -c sign/);
  assert.match(out, /__fish_use_subcommand/);
  // Subcommand awareness
  assert.match(out, /__fish_seen_subcommand_from request/);
  // Common flag and provider enum
  assert.match(out, /-l "request-id"/);
  assert.match(out, /-l provider -xa "dropbox docusign signwell local"/);
});

test("generateCompletionScript dispatches by shell name", () => {
  assert.equal(generateCompletionScript("bash"), generateBashCompletion());
  assert.equal(generateCompletionScript("zsh"), generateZshCompletion());
  assert.equal(generateCompletionScript("fish"), generateFishCompletion());
});

test("generateCompletionScript throws for unsupported shells", () => {
  assert.throws(() => generateCompletionScript("powershell" as never), /Unsupported shell/);
});
