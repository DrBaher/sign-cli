import test from "node:test";
import assert from "node:assert/strict";
import { createLogger, resolveLogMode } from "../lib/logger.js";

test("resolveLogMode defaults to human and accepts json", () => {
  assert.equal(resolveLogMode(undefined), "human");
  assert.equal(resolveLogMode("json"), "json");
  assert.equal(resolveLogMode("HUMAN"), "human");
});

test("logger emits json with level/msg/fields", () => {
  const lines: string[] = [];
  const logger = createLogger({ mode: "json", sink: (line) => lines.push(line) });
  logger.info("hello", { request_id: "r_1", status: "sent" });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "hello");
  assert.equal(parsed.request_id, "r_1");
  assert.equal(parsed.status, "sent");
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("logger emits human format with key=value", () => {
  const lines: string[] = [];
  const logger = createLogger({ mode: "human", sink: (line) => lines.push(line) });
  logger.warn("almost done", { attempts: 3 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[warn\] almost done attempts=3$/);
});
