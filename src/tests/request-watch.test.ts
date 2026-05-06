import test from "node:test";
import assert from "node:assert/strict";
import { watchSigningRequestStatus } from "../lib/signing-service.js";
import { createDb, createDocumentFixture, makeTempDb } from "./helpers.js";

test("watchSigningRequestStatus exits completed and fetches final PDF when requested", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);

  try {
    const statuses = ["sent", "completed"];
    const calls: string[] = [];
    const result = await watchSigningRequestStatus(db, {
      requestId: "req_demo",
      apiKey: "test-key",
      intervalMs: 1,
      fetchFinalPdf: true,
      sleep: async () => undefined,
      getStatus: async () => {
        const status = statuses.shift() ?? "completed";
        calls.push(status);
        return {
          request: { dropbox_status: status },
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
    assert.equal(result.terminal, "completed");
    assert.equal(result.attempts, 2);
    assert.equal(result.finalPdf?.sha256, "abc123");
    assert.deepEqual(calls, ["sent", "completed"]);
  } finally {
    cleanup();
  }
});

test("watchSigningRequestStatus exits declined on declined status", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);

  try {
    const result = await watchSigningRequestStatus(db, {
      requestId: "req_demo",
      apiKey: "test-key",
      intervalMs: 1,
      sleep: async () => undefined,
      getStatus: async () => ({
        request: { dropbox_status: "declined" },
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
    assert.equal(result.finalPdf, null);
  } finally {
    cleanup();
  }
});

test("watchSigningRequestStatus exits timeout when terminal state is not reached", async () => {
  const { dbPath, cleanup } = makeTempDb();
  const db = createDb(dbPath);
  const realNow = Date.now;

  try {
    let now = 0;
    Date.now = () => now;

    const result = await watchSigningRequestStatus(db, {
      requestId: "req_demo",
      apiKey: "test-key",
      intervalMs: 5,
      timeoutMs: 10,
      sleep: async (ms) => {
        now += ms;
      },
      getStatus: async () => ({
        request: { dropbox_status: "sent" },
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
  } finally {
    Date.now = realNow;
    cleanup();
  }
});
