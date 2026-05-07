import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Sanity-only: confirm the package.json wires up `npm run coverage` to Node's
// built-in --experimental-test-coverage with the LCOV reporter we depend on
// in CI. We avoid actually running the script here because the test suite
// already runs once per `npm test`.

test("package.json defines a `coverage` script that writes coverage.lcov", () => {
  const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const cov = pkg.scripts.coverage;
  assert.ok(cov, "expected scripts.coverage in package.json");
  assert.match(cov, /--experimental-test-coverage/);
  assert.match(cov, /--test-reporter=lcov/);
  assert.match(cov, /--test-reporter-destination=coverage\.lcov/);
});

test("coverage script enforces minimum line / function / branch thresholds", () => {
  const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const cov = pkg.scripts.coverage;
  assert.match(cov, /--test-coverage-lines=\d+/);
  assert.match(cov, /--test-coverage-functions=\d+/);
  assert.match(cov, /--test-coverage-branches=\d+/);
  // Tests are excluded from the rollup so the floor reflects lib code only.
  assert.match(cov, /--test-coverage-exclude=/);
});

test("CI workflow runs `npm run coverage` and uploads the lcov artifact", () => {
  const ci = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /npm run coverage/);
  assert.match(ci, /coverage\.lcov/);
});
