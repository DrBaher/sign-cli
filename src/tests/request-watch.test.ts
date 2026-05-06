import test from "node:test";
import assert from "node:assert/strict";
import { createSigningRequest, watchSigningRequestStatus } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("watchSigningRequestStatus exits completed and fetches final PDF when requested", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("watch");
  const realNow = Date.now;

  try {
    Date.now = () => 0;
    const created = createSigningRequest(db, {
      title: "Watch Contract",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "dropbox",
      autoApprove: true,
      now: new Date(0),
    });
    const statuses = ["sent", "completed"];
    const calls: string[] = [];
    const result = await watchSigningRequestStatus(db, {
      requestId: created.requestId,
      apiKey: "test-key",
      intervalMs: 1,
      now: new Date(0),
      fetchFinalPdf: true,
      sleep: async () => undefined,
      getStatus: async () => {
        const status = statuses.shift() ?? "completed";
        calls.push(status);
        return {
          request: { provider_status: status },
          remoteStatus: {
            signature_request: {
              status_code: status,
              is_complete: status === "completed",
            },
          },
        } as any;
      },
      fetchFinal: async () => ({
        path: createDocumentFixture("signed"),
        bytes: 6,
        sha256: "abc123",
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.provider, "dropbox");
    assert.equal(result.terminal, "completed");
    assert.equal(result.attempts, 2);
    assert.equal(result.startedAt, new Date(0).toISOString());
    assert.equal(result.elapsedMs, 0);
    assert.deepEqual(result.lastRemoteStatus, {
      signature_request: {
        status_code: "completed",
        is_complete: true,
      },
    });
    assert.equal(result.finalPdf?.sha256, "abc123");
    assert.deepEqual(calls, ["sent", "completed"]);
  } finally {
    Date.now = realNow;
    cleanup();
  }
});

test("watchSigningRequestStatus exits declined on declined status", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("declined");
  const realNow = Date.now;

  try {
    Date.now = () => 0;
    const created = createSigningRequest(db, {
      title: "Declined Contract",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "dropbox",
      autoApprove: true,
      now: new Date(0),
    });
    const result = await watchSigningRequestStatus(db, {
      requestId: created.requestId,
      apiKey: "test-key",
      intervalMs: 1,
      now: new Date(0),
      sleep: async () => undefined,
      getStatus: async () => ({
        request: { provider_status: "declined" },
        remoteStatus: {
          signature_request: {
            status_code: "declined",
            is_complete: false,
          },
        },
      }) as any,
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.terminal, "declined");
    assert.equal(result.startedAt, new Date(0).toISOString());
    assert.equal(result.elapsedMs, 0);
    assert.equal(result.finalPdf, null);
  } finally {
    Date.now = realNow;
    cleanup();
  }
});

test("watchSigningRequestStatus exits timeout when terminal state is not reached", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("timeout");
  const realNow = Date.now;

  try {
    let now = 0;
    Date.now = () => now;
    const created = createSigningRequest(db, {
      title: "Timeout Contract",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "dropbox",
      autoApprove: true,
      now: new Date(0),
    });

    const result = await watchSigningRequestStatus(db, {
      requestId: created.requestId,
      apiKey: "test-key",
      intervalMs: 5,
      timeoutMs: 10,
      sleep: async (ms) => {
        now += ms;
      },
      getStatus: async () => ({
        request: { provider_status: "sent" },
        remoteStatus: {
          signature_request: {
            status_code: "sent",
            is_complete: false,
          },
        },
      }) as any,
    });

    assert.equal(result.exitCode, 4);
    assert.equal(result.terminal, "timeout");
    assert.equal(result.attempts, 3);
    assert.equal(result.startedAt, new Date(0).toISOString());
    assert.equal(result.elapsedMs, 10);
    assert.deepEqual(result.lastRemoteStatus, {
      signature_request: {
        status_code: "sent",
        is_complete: false,
      },
    });
  } finally {
    Date.now = realNow;
    cleanup();
  }
});

test("watchSigningRequestStatus normalizes DocuSign terminal statuses", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const documentPath = createDocumentFixture("voided");
  const realNow = Date.now;

  try {
    Date.now = () => 0;
    const created = createSigningRequest(db, {
      title: "DocuSign Contract",
      documentPath,
      signers: [{ name: "Alice", email: "alice@example.com", order: 1 }],
      tokenTtlMinutes: 60,
      provider: "docusign",
      autoApprove: true,
      now: new Date(0),
    });
    const result = await watchSigningRequestStatus(db, {
      requestId: created.requestId,
      provider: "docusign",
      intervalMs: 1,
      now: new Date(0),
      sleep: async () => undefined,
      getStatus: async () => ({
        request: { provider_status: "voided" },
        remoteStatus: {
          status: "voided",
        },
      }) as any,
    });

    assert.equal(result.provider, "docusign");
    assert.equal(result.exitCode, 2);
    assert.equal(result.terminal, "declined");
    assert.equal(result.status, "voided");
  } finally {
    Date.now = realNow;
    cleanup();
  }
});
