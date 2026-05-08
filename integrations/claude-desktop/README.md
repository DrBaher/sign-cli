# Claude Desktop integration

Wires `sign mcp serve` into [Claude Desktop](https://claude.ai/download)
as a tool source. After this, you can ask Claude things like "show me
pending requests for alice@example.com" or "verify the audit chain on
req_…" and it'll call the right MCP tools.

## Install

1. Build the CLI on your machine:

   ```bash
   git clone https://github.com/DrBaher/sign-cli && cd sign-cli
   npm install && npm run build
   ```

2. Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
   (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows).
   Add the snippet from [`claude_desktop_config.json`](./claude_desktop_config.json)
   to the `mcpServers` block. Replace `/absolute/path/to/sign-cli` with
   the real path to your clone.

3. Restart Claude Desktop. The sign-cli tools (`signer_list`,
   `request_show`, `audit_verify`, …) appear in the agent's tool catalog.

## What this configuration does

- Runs the built `dist/cli.js mcp serve` on stdio.
- Locks the agent to **read-only** tools (`signer_list`, `request_show`,
  `audit_verify`, `request_status`, `request_watch`,
  `signer_fetch_document`). Lifecycle mutations (`sign`, `signer_decline`)
  are blocked at the MCP layer.
- Restricts capabilities to `tools` only — the agent doesn't see
  resources or prompts, so it can't probe for them.
- Tees every JSON-RPC message to `~/.sign-cli/mcp.ndjson` with token
  redaction enabled so the log is safe to share with a SIEM.

## Letting the agent sign

If you actually want the agent to drive lifecycle (after explicit user
approval), drop `--read-only true` and add `sign` and `signer_decline`
to the `--tool` list. We strongly recommend keeping `--emit-events` on.
