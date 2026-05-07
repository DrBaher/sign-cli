import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  evaluatePolicy,
  loadPolicySpec,
  parsePolicySpec,
} from "../lib/policy-engine.js";
import { SignCliError } from "../lib/sign-error.js";
import {
  createSigningRequest,
  getSigningRequestStatus,
  listAuditEvents,
  runSignerPolicy,
  sendSigningRequest,
} from "../lib/signing-service.js";
import { createDb, makeTempDb } from "./helpers.js";

function withScopedLocalStorage<T>(fn: () => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-"));
  const previousStore = process.env.SIGN_LOCAL_STORE_DIR;
  const previousAuto = process.env.SIGN_LOCAL_AUTOCOMPLETE;
  process.env.SIGN_LOCAL_STORE_DIR = path.join(dir, "store");
  process.env.SIGN_LOCAL_AUTOCOMPLETE = "false";
  const restore = () => {
    if (previousStore === undefined) delete process.env.SIGN_LOCAL_STORE_DIR;
    else process.env.SIGN_LOCAL_STORE_DIR = previousStore;
    if (previousAuto === undefined) delete process.env.SIGN_LOCAL_AUTOCOMPLETE;
    else process.env.SIGN_LOCAL_AUTOCOMPLETE = previousAuto;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function makeFixturePdf(dir: string): string {
  const documentPath = path.join(dir, "doc.pdf");
  writeFileSync(documentPath, Buffer.from("%PDF-1.4\n%nothing\n%%EOF", "latin1"));
  return documentPath;
}

async function bootstrap(input: { title: string }): Promise<{
  db: ReturnType<typeof createDb>;
  cleanup: () => void;
  requestId: string;
  aliceToken: string;
}> {
  const { dbPath, cleanup: dbCleanup } = makeTempDb();
  const db = createDb(dbPath);
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-doc-"));
  const documentPath = makeFixturePdf(dir);
  const created = createSigningRequest(db, {
    title: input.title,
    documentPath,
    signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
    tokenTtlMinutes: 30,
    provider: "local",
    autoApprove: true,
  });
  await sendSigningRequest(db, { requestId: created.requestId, provider: "local", testMode: true });
  return {
    db,
    cleanup: () => {
      db.close();
      dbCleanup();
      rmSync(dir, { recursive: true, force: true });
    },
    requestId: created.requestId,
    aliceToken: created.tokens[0].token,
  };
}

test("parsePolicySpec rejects malformed shapes (missing rules, bad match, bad action)", () => {
  assert.throws(
    () => parsePolicySpec({ rules: [] }),
    (err: unknown) => err instanceof SignCliError && err.code === "INVALID_SPEC",
  );
  assert.throws(
    () => parsePolicySpec({ rules: [{ match: {}, action: "sign" }] }),
    (err: unknown) => err instanceof SignCliError && err.code === "INVALID_SPEC",
  );
  assert.throws(
    () => parsePolicySpec({ rules: [{ match: "any", action: "burn" }] }),
    (err: unknown) => err instanceof SignCliError && err.code === "INVALID_SPEC",
  );
});

test("evaluatePolicy picks the first matching rule and falls through to decline", () => {
  const spec = parsePolicySpec({
    rules: [
      { match: { titlePattern: "addendum" }, action: "decline", reason: "addendum" },
      { match: { titlePattern: "^NDA" }, action: "sign" },
    ],
  });
  const ndaDecision = evaluatePolicy(spec, { title: "NDA - acme", documentSha256: "abc", signerEmail: "x@y" });
  assert.equal(ndaDecision.action, "sign");
  assert.equal(ndaDecision.matchedRuleIndex, 1);

  const addDecision = evaluatePolicy(spec, { title: "addendum to NDA", documentSha256: "abc", signerEmail: "x@y" });
  assert.equal(addDecision.action, "decline");
  assert.equal(addDecision.reason, "addendum");

  const noMatch = evaluatePolicy(spec, { title: "Other thing", documentSha256: "abc", signerEmail: "x@y" });
  assert.equal(noMatch.action, "decline");
  assert.equal(noMatch.matchedRuleIndex, null);
  assert.match(noMatch.reason ?? "", /No matching/);
});

test("evaluatePolicy throws POLICY_VIOLATION when expectations fail", () => {
  const spec = parsePolicySpec({
    expectations: { titleMatches: "^Mutual NDA" },
    rules: [{ match: "any", action: "sign" }],
  });
  assert.throws(
    () => evaluatePolicy(spec, { title: "Sneaky retitle", documentSha256: "abc", signerEmail: "x@y" }),
    (err: unknown) => err instanceof SignCliError && err.code === "POLICY_VIOLATION",
  );
});

test("evaluatePolicy validates documentSha256Whitelist and signerEmail expectations", () => {
  const spec = parsePolicySpec({
    expectations: {
      documentSha256Whitelist: ["aabbcc", "ddeeff"],
      signerEmail: "alice@example.com",
    },
    rules: [{ match: "any", action: "sign" }],
  });
  // OK
  const ok = evaluatePolicy(spec, { title: "x", documentSha256: "AABBCC", signerEmail: "Alice@Example.com" });
  assert.equal(ok.action, "sign");
  // Wrong hash
  assert.throws(
    () => evaluatePolicy(spec, { title: "x", documentSha256: "999", signerEmail: "alice@example.com" }),
    (err: unknown) => err instanceof SignCliError && err.code === "POLICY_VIOLATION",
  );
  // Wrong signer
  assert.throws(
    () => evaluatePolicy(spec, { title: "x", documentSha256: "aabbcc", signerEmail: "bob@example.com" }),
    (err: unknown) => err instanceof SignCliError && err.code === "POLICY_VIOLATION",
  );
});

test("runSignerPolicy applies a sign action against the request", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap({ title: "Mutual NDA — round 1" });
    try {
      const spec = parsePolicySpec({
        rules: [{ match: { titlePattern: "^Mutual NDA" }, action: "sign" }],
      });
      const outcome = runSignerPolicy(ctx.db, { requestId: ctx.requestId, token: ctx.aliceToken, spec });
      assert.equal(outcome.applied, true);
      assert.equal(outcome.decision.action, "sign");
      const status = await getSigningRequestStatus(ctx.db, { requestId: ctx.requestId, provider: "local" });
      assert.equal(status.request.status, "completed");
    } finally {
      ctx.cleanup();
    }
  });
});

test("runSignerPolicy applies a decline action with the rule's reason", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap({ title: "Risky addendum to NDA" });
    try {
      const spec = parsePolicySpec({
        rules: [
          { match: { titlePattern: "addendum" }, action: "decline", reason: "Addenda need human review" },
          { match: "any", action: "sign" },
        ],
      });
      const outcome = runSignerPolicy(ctx.db, { requestId: ctx.requestId, token: ctx.aliceToken, spec });
      assert.equal(outcome.applied, true);
      assert.equal(outcome.decision.action, "decline");
      assert.equal(outcome.decision.reason, "Addenda need human review");
      const status = await getSigningRequestStatus(ctx.db, { requestId: ctx.requestId, provider: "local" });
      assert.equal(status.request.status, "declined");
    } finally {
      ctx.cleanup();
    }
  });
});

test("runSignerPolicy with dryRun records the decision but doesn't mutate state", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap({ title: "Mutual NDA dry-run" });
    try {
      const spec = parsePolicySpec({ rules: [{ match: "any", action: "sign" }] });
      const outcome = runSignerPolicy(ctx.db, {
        requestId: ctx.requestId,
        token: ctx.aliceToken,
        spec,
        dryRun: true,
      });
      assert.equal(outcome.applied, false);
      assert.equal(outcome.decision.action, "sign");
      const status = await getSigningRequestStatus(ctx.db, { requestId: ctx.requestId, provider: "local" });
      assert.equal(status.request.status, "sent", "dry-run must not flip status to completed");
      const events = listAuditEvents(ctx.db, ctx.requestId);
      assert.ok(events.some((e) => e.event_type === "request.signer_policy_evaluated"));
    } finally {
      ctx.cleanup();
    }
  });
});

test("runSignerPolicy throws POLICY_VIOLATION when expectations don't match the actual request", { concurrency: false }, async () => {
  await withScopedLocalStorage(async () => {
    const ctx = await bootstrap({ title: "Different document" });
    try {
      const spec = parsePolicySpec({
        expectations: { titleMatches: "^Mutual NDA" },
        rules: [{ match: "any", action: "sign" }],
      });
      assert.throws(
        () => runSignerPolicy(ctx.db, { requestId: ctx.requestId, token: ctx.aliceToken, spec }),
        (err: unknown) => err instanceof SignCliError && err.code === "POLICY_VIOLATION",
      );
      const status = await getSigningRequestStatus(ctx.db, { requestId: ctx.requestId, provider: "local" });
      assert.equal(status.request.status, "sent", "expectations failure must not mutate the request");
    } finally {
      ctx.cleanup();
    }
  });
});

test("loadPolicySpec parses a real JSON file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sign-policy-load-"));
  const policyPath = path.join(dir, "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: 1,
      rules: [
        { match: { titlePattern: "^A" }, action: "sign" },
        { match: "any", action: "decline" },
      ],
    }),
    "utf8",
  );
  try {
    const spec = loadPolicySpec(policyPath);
    assert.equal(spec.version, 1);
    assert.equal(spec.rules.length, 2);
    assert.equal(spec.rules[0].action, "sign");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
