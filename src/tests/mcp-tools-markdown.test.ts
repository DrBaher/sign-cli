import test from "node:test";
import assert from "node:assert/strict";
import { renderMcpToolsAsMarkdown, listMcpTools } from "../lib/mcp-server.js";

test("renderMcpToolsAsMarkdown produces a docs page with one heading per tool + JSON code blocks", () => {
  const md = renderMcpToolsAsMarkdown();
  const tools = listMcpTools();
  assert.match(md, /^# MCP tools/);
  for (const tool of tools) {
    assert.ok(md.includes(`## \`${tool.name}\``), `markdown should contain a heading for ${tool.name}`);
  }
  // Every tool has an Input section. Output sections appear only when the
  // tool ships an outputSchema (one tool — signer_list — intentionally skips it).
  const toolsWithOutputSchema = tools.filter((t) => t.outputSchema !== undefined);
  const inputCount = (md.match(/### Input/g) ?? []).length;
  const outputCount = (md.match(/### Output/g) ?? []).length;
  assert.equal(inputCount, tools.length);
  assert.equal(outputCount, toolsWithOutputSchema.length);
  // Code fences appear in pairs. Each tool contributes one Input block (2 fences),
  // tools with an outputSchema contribute another (2 fences), and any progress-emitting
  // tool contributes one more (2 fences).
  const fenceCount = (md.match(/```/g) ?? []).length;
  const progressTools = tools.filter((t) => (t as unknown as { progressSchema?: unknown }).progressSchema).length;
  const expected = tools.length * 2 + toolsWithOutputSchema.length * 2 + progressTools * 2;
  assert.equal(fenceCount, expected);
});
