import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProviderStatus, resolveWatchTerminalStatus } from "../lib/signing-service.js";
import { resolveSignProvider } from "../lib/providers.js";

test("resolveSignProvider defaults to local (offline, no credentials)", () => {
  const original = process.env.SIGN_PROVIDER;
  delete process.env.SIGN_PROVIDER;

  try {
    assert.equal(resolveSignProvider(), "local");
  } finally {
    if (original === undefined) {
      delete process.env.SIGN_PROVIDER;
    } else {
      process.env.SIGN_PROVIDER = original;
    }
  }
});

test("resolveSignProvider prefers explicit flag over env", () => {
  const original = process.env.SIGN_PROVIDER;
  process.env.SIGN_PROVIDER = "dropbox";

  try {
    assert.equal(resolveSignProvider("docusign"), "docusign");
  } finally {
    if (original === undefined) {
      delete process.env.SIGN_PROVIDER;
    } else {
      process.env.SIGN_PROVIDER = original;
    }
  }
});

test("resolveSignProvider accepts signwell", () => {
  assert.equal(resolveSignProvider("signwell"), "signwell");
});

test("normalizeProviderStatus handles Dropbox, DocuSign, and SignWell payloads", () => {
  assert.equal(normalizeProviderStatus("dropbox", {
    signature_request: {
      status_code: "sent",
      is_complete: false,
    },
  }), "sent");

  assert.equal(normalizeProviderStatus("docusign", {
    status: "completed",
  }), "completed");

  assert.equal(normalizeProviderStatus("signwell", {
    status: "In Progress",
  }), "in_progress");
});

test("resolveWatchTerminalStatus normalizes shared terminal states", () => {
  assert.equal(resolveWatchTerminalStatus("completed"), "completed");
  assert.equal(resolveWatchTerminalStatus("voided"), "declined");
  assert.equal(resolveWatchTerminalStatus("failed"), "error");
  assert.equal(resolveWatchTerminalStatus("bounced"), "error");
});
