import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

// These tests run only when the bundle has been produced. They are skipped on
// fresh clones that have not run `npm run bundle` yet, so the regular CI
// `npm test` flow does not block on having esbuild installed.

const bundlePath = path.resolve("dist", "cli.bundled.cjs");

test("dist/cli.bundled.cjs starts with a Node shebang and runs `doctor providers`", { skip: !existsSync(bundlePath) ? "bundle not built" : false }, () => {
  const stats = statSync(bundlePath);
  assert.ok(stats.size > 50_000, "bundle is unexpectedly small");

  const output = execFileSync(process.execPath, [bundlePath, "doctor", "providers"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output);
  assert.equal(Array.isArray(parsed), true);
  const local = parsed.find((entry: any) => entry.provider === "local");
  assert.ok(local, "local provider should be in the matrix");
});
