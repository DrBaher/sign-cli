import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { runSelftest } from "../lib/selftest.js";

test("runSelftest exits ok with all canonical steps green", { concurrency: false }, async () => {
  const report = await runSelftest();
  assert.equal(report.ok, true, `selftest steps: ${JSON.stringify(report.steps, null, 2)}`);
  const stepNames = report.steps.map((s) => s.name);
  for (const expected of [
    "request.create",
    "request.send",
    "sign.sign",
    "request.fetch-final",
    "request.verify-signed-pdf",
    "audit.verify",
    "request.receipt",
    "request.verify-receipt",
    "mcp.handshake",
  ]) {
    assert.ok(stepNames.includes(expected), `missing step ${expected}`);
  }
  assert.equal(report.cleaned, true, "default mode must clean up the workspace");
  assert.equal(existsSync(report.workspace), false);
});

test("runSelftest --keep-workspace=true preserves the temp dir for inspection", { concurrency: false }, async () => {
  const report = await runSelftest({ keepWorkspace: true });
  try {
    assert.equal(report.ok, true);
    assert.equal(report.cleaned, false);
    assert.equal(existsSync(report.workspace), true);
  } finally {
    const fs = await import("node:fs");
    fs.rmSync(report.workspace, { recursive: true, force: true });
  }
});
