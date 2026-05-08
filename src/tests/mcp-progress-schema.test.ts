import test from "node:test";
import assert from "node:assert/strict";
import { listMcpTools, renderMcpToolsAsMarkdown } from "../lib/mcp-server.js";

test("listMcpTools surfaces a progressSchema for request_watch (the only tool that emits notifications/progress today)", () => {
  const tools = listMcpTools();
  const watch = tools.find((t) => t.name === "request_watch");
  assert.ok(watch, "request_watch tool should be listed");
  const schema = (watch as unknown as { progressSchema?: Record<string, unknown> }).progressSchema;
  assert.ok(schema, "request_watch should expose progressSchema");
  assert.equal((schema as { type?: string }).type, "object");
  const required = (schema as { required?: string[] }).required;
  assert.ok(required?.includes("progress"));
  assert.ok(required?.includes("message"));
});

test("listMcpTools omits progressSchema for tools that don't emit progress notifications", () => {
  const tools = listMcpTools();
  for (const tool of tools) {
    if (tool.name === "request_watch") continue;
    const schema = (tool as unknown as { progressSchema?: unknown }).progressSchema;
    assert.equal(schema, undefined, `${tool.name} should not expose a progressSchema`);
  }
});

test("renderMcpToolsAsMarkdown includes a Progress notifications section for request_watch", () => {
  const md = renderMcpToolsAsMarkdown();
  // Find the request_watch heading and confirm a Progress notifications block follows.
  const idx = md.indexOf("## `request_watch`");
  assert.ok(idx >= 0);
  const watchSection = md.slice(idx, md.indexOf("## `", idx + 4) === -1 ? undefined : md.indexOf("## `", idx + 4));
  assert.match(watchSection, /### Progress notifications/);
  // The Progress notifications block exists exactly once across the doc
  // (only request_watch emits progress today).
  const progressMatches = md.match(/### Progress notifications/g) ?? [];
  assert.equal(progressMatches.length, 1);
});
