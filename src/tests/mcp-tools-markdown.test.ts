import test from "node:test";
import assert from "node:assert/strict";
import { renderMcpToolsAsMarkdown, listMcpTools } from "../lib/mcp-server.js";

test("renderMcpToolsAsMarkdown produces a docs page with one heading per tool + JSON code blocks", () => {
  const md = renderMcpToolsAsMarkdown();
  const tools = listMcpTools();
  assert.match(md, /^# MCP tools/);
  for (const tool of tools) {
    // Each tool name appears as a level-2 heading.
    assert.ok(md.includes(`## \`${tool.name}\``), `markdown should contain a heading for ${tool.name}`);
  }
  // Every tool has both Input and Output sections (since we ship outputSchema for all).
  const inputCount = (md.match(/### Input/g) ?? []).length;
  const outputCount = (md.match(/### Output/g) ?? []).length;
  assert.equal(inputCount, tools.length);
  assert.equal(outputCount, tools.length);
  // Code fences should appear in pairs around each schema.
  const fenceCount = (md.match(/```/g) ?? []).length;
  // Two code blocks per tool minimum (Input + Output), plus one extra block
  // for any tool that emits notifications/progress. Each block = 2 fences.
  const progressTools = tools.filter((t) => (t as unknown as { progressSchema?: unknown }).progressSchema).length;
  assert.equal(fenceCount, tools.length * 4 + progressTools * 2);
});
