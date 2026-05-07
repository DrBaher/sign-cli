import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Sanity: confirms the strict-typecheck pipeline is wired into both npm and CI.
// We DON'T run tsc here (the parent `npm test` already builds with type-strip;
// the typecheck step lives in `npm run typecheck`).

test("tsconfig.json has strict: true and noEmit: true", () => {
  const cfg = JSON.parse(readFileSync(path.resolve("tsconfig.json"), "utf8")) as {
    compilerOptions: Record<string, unknown>;
  };
  assert.equal(cfg.compilerOptions.strict, true);
  assert.equal(cfg.compilerOptions.noEmit, true);
});

test("package.json defines a `typecheck` script that runs tsc --noEmit", () => {
  const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
    prepublishOnly?: string;
  };
  assert.match(pkg.scripts.typecheck, /tsc --noEmit/);
  assert.match(pkg.scripts.prepublishOnly, /typecheck/);
  assert.ok(pkg.devDependencies.typescript, "typescript must be a devDependency");
  assert.ok(pkg.devDependencies["@types/node"], "@types/node must be a devDependency");
});

test("CI workflow runs `npm run typecheck` before tests", () => {
  const ci = readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8");
  const typecheckIdx = ci.indexOf("npm run typecheck");
  const testIdx = ci.indexOf("npm test");
  assert.ok(typecheckIdx > 0, "CI must run npm run typecheck");
  assert.ok(typecheckIdx < testIdx, "typecheck must run before tests");
});
