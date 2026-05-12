import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProviderMatchesPersisted,
  describeProviderSource,
  resolveSignProviderWithSource,
  strictProviderEnabled,
} from "../lib/providers.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key]!;
  }
  try { return fn(); }
  finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  }
}

test("resolveSignProviderWithSource: --provider flag wins, source=flag", () => {
  const r = withEnv({ SIGN_PROVIDER: "dropbox" }, () =>
    resolveSignProviderWithSource("local"));
  assert.equal(r.provider, "local");
  assert.equal(r.source, "flag");
});

test("resolveSignProviderWithSource: fallback (persisted) used when flag missing", () => {
  const r = withEnv({ SIGN_PROVIDER: "dropbox" }, () =>
    resolveSignProviderWithSource(undefined, "signwell"));
  assert.equal(r.provider, "signwell");
  assert.equal(r.source, "fallback");
});

test("resolveSignProviderWithSource: env var used when no flag or fallback", () => {
  const r = withEnv({ SIGN_PROVIDER: "docusign" }, () =>
    resolveSignProviderWithSource());
  assert.equal(r.provider, "docusign");
  assert.equal(r.source, "env");
});

test("resolveSignProviderWithSource: default 'dropbox' when nothing set", () => {
  const r = withEnv({ SIGN_PROVIDER: undefined }, () =>
    resolveSignProviderWithSource());
  assert.equal(r.provider, "dropbox");
  assert.equal(r.source, "default");
});

test("describeProviderSource produces human-readable text for each source", () => {
  assert.match(describeProviderSource("flag"), /--provider flag/);
  assert.match(describeProviderSource("env"), /SIGN_PROVIDER env/);
  assert.match(describeProviderSource("fallback"), /persisted/);
  assert.match(describeProviderSource("default"), /default/);
});

test("strictProviderEnabled: flag wins over env", () => {
  withEnv({ SIGN_STRICT_PROVIDER: "false" }, () => {
    assert.equal(strictProviderEnabled("true"), true);
  });
  withEnv({ SIGN_STRICT_PROVIDER: "true" }, () => {
    assert.equal(strictProviderEnabled("false"), false);
  });
});

test("strictProviderEnabled: env=true enables when flag absent", () => {
  withEnv({ SIGN_STRICT_PROVIDER: "true" }, () => {
    assert.equal(strictProviderEnabled(), true);
  });
});

test("strictProviderEnabled: default is false (back-compat)", () => {
  withEnv({ SIGN_STRICT_PROVIDER: undefined }, () => {
    assert.equal(strictProviderEnabled(), false);
  });
});

test("assertProviderMatchesPersisted: passes when runtime equals persisted", () => {
  assert.doesNotThrow(() => assertProviderMatchesPersisted("local", "local", true));
});

test("assertProviderMatchesPersisted: throws when mismatch and strict=true", () => {
  assert.throws(
    () => assertProviderMatchesPersisted("local", "dropbox", true),
    /runtime=local.*persisted=dropbox/,
  );
});

test("assertProviderMatchesPersisted: no-op when strict=false (back-compat)", () => {
  assert.doesNotThrow(() => assertProviderMatchesPersisted("local", "dropbox", false));
});
