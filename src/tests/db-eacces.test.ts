import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../lib/db.js";
import { SignCliError } from "../lib/sign-error.js";

// Verify openDatabase wraps unwritable-parent failures into a structured
// STORAGE_UNWRITABLE SignCliError instead of leaking the raw Node EACCES
// stack trace. This is the difference between an agent getting a clean
// machine-readable code/hint and the user seeing a confusing crash.
test("openDatabase wraps EACCES on parent mkdir into STORAGE_UNWRITABLE", () => {
  // Skip on root — root can usually create anywhere even with 0o555, which
  // would defeat the test.
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const root = mkdtempSync(path.join(os.tmpdir(), "db-eacces-"));
  try {
    chmodSync(root, 0o555); // read+exec only; mkdir of a child must fail
    try {
      openDatabase(path.join(root, "nested", "sign.db"));
      assert.fail("Expected openDatabase to throw");
    } catch (err) {
      assert.ok(err instanceof SignCliError, `Expected SignCliError, got ${err}`);
      assert.equal((err as SignCliError).code, "STORAGE_UNWRITABLE");
      assert.ok((err as SignCliError).hint && (err as SignCliError).hint!.length > 0);
    }
  } finally {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
