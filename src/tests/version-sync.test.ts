// sign-cli reports its version from three hand-bumped spots that have drifted
// before (SIGN_CLI_VERSION was stuck at 0.6.4 while the package shipped 0.6.5).
// Pin all of them to package.json so a release that misses one fails CI.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SIGN_CLI_VERSION } from "../lib/help-catalog.js";

// dist/tests/version-sync.test.js -> repo root is two levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

test("SIGN_CLI_VERSION matches package.json", () => {
  assert.equal(SIGN_CLI_VERSION, pkg.version);
});

test("server.json versions match package.json", () => {
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].version, pkg.version);
});
