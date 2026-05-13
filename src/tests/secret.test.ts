import test from "node:test";
import assert from "node:assert/strict";
import {
  collectKnownSecrets,
  fingerprintSecret,
  redactErrorMessage,
  redactHeaders,
  redactSecretValue,
  redactString,
  registerSecretKey,
} from "../lib/secret.js";

test("redactSecretValue keeps prefix/suffix and replaces middle", () => {
  assert.equal(redactSecretValue("abc"), "***");
  assert.equal(redactSecretValue("abcdefghij"), "abc***ij");
});

test("fingerprintSecret returns prefix + 8-byte sha256 fingerprint", () => {
  const fp = fingerprintSecret("dropbox-secret-XYZ");
  assert.match(fp, /^drop\*\*\*[0-9a-f]{8}$/);
  const fp2 = fingerprintSecret("dropbox-secret-XYZ");
  assert.equal(fp, fp2);
  assert.notEqual(fp, fingerprintSecret("dropbox-secret-OTHER"));
});

test("redactString masks every occurrence of every known secret", () => {
  const masked = redactString("api key dropbox-secret-XYZ logged twice: dropbox-secret-XYZ", ["dropbox-secret-XYZ"]);
  assert.ok(!masked.includes("dropbox-secret-XYZ"));
  assert.match(masked, /dro\*\*\*YZ/);
});

test("redactHeaders masks Authorization and x-api-key but leaves Accept", () => {
  const out = redactHeaders({
    Authorization: "Basic abcdefgh",
    "x-api-key": "sk_live_1234567890",
    Accept: "application/json",
  });
  assert.match(out.Authorization, /^Bas\*\*\*gh$/);
  assert.match(out["x-api-key"], /^sk_\*\*\*90$/);
  assert.equal(out.Accept, "application/json");
});

test("redactErrorMessage strips known env secrets from error text", () => {
  const original = process.env.SIGNWELL_API_KEY;
  process.env.SIGNWELL_API_KEY = "supersecret_token_value";
  try {
    const err = new Error("SignWell request failed: bad auth supersecret_token_value present");
    const cleaned = redactErrorMessage(err);
    assert.ok(!cleaned.includes("supersecret_token_value"));
    assert.match(cleaned, /sup\*\*\*ue/);
  } finally {
    if (original === undefined) delete process.env.SIGNWELL_API_KEY;
    else process.env.SIGNWELL_API_KEY = original;
  }
});

test("collectKnownSecrets reads only set env vars", () => {
  const original = process.env.DROPBOX_SIGN_API_KEY;
  process.env.DROPBOX_SIGN_API_KEY = "the-key";
  try {
    assert.ok(collectKnownSecrets().includes("the-key"));
  } finally {
    if (original === undefined) delete process.env.DROPBOX_SIGN_API_KEY;
    else process.env.DROPBOX_SIGN_API_KEY = original;
  }
});

test("registerSecretKey: custom env-var names get their values redacted", () => {
  // Simulates what `applyCredentialsToProcessEnv` does for a profile's
  // `credentials: { CUSTOM_API_KEY: "..." }` block — without registration,
  // the custom value would leak in error messages because
  // collectKnownSecrets() only knows about the four hardcoded provider
  // env vars.
  const saved = process.env.CUSTOM_AUDIT_TEST_VAR;
  process.env.CUSTOM_AUDIT_TEST_VAR = "super-secret-token-from-profile";
  try {
    // Before registration: the value is NOT in collectKnownSecrets
    const before = collectKnownSecrets();
    assert.equal(before.includes("super-secret-token-from-profile"), false,
      "by default, only hardcoded env vars are redacted");

    registerSecretKey("CUSTOM_AUDIT_TEST_VAR");
    const after = collectKnownSecrets();
    assert.ok(after.includes("super-secret-token-from-profile"),
      "registerSecretKey should make the env var's value part of the known set");

    // End-to-end: redactErrorMessage scrubs the value too.
    const errMsg = "An error occurred with token super-secret-token-from-profile in flight.";
    const redacted = redactErrorMessage(new Error(errMsg));
    assert.equal(redacted.includes("super-secret-token-from-profile"), false,
      "redactErrorMessage should mask the value of a registered custom env var");
  } finally {
    if (saved === undefined) delete process.env.CUSTOM_AUDIT_TEST_VAR;
    else process.env.CUSTOM_AUDIT_TEST_VAR = saved;
  }
});
