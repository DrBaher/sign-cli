# Integrations

Drop-in starters for the most common ways `sign-cli` gets wired into other
systems. Each subdirectory is a self-contained example you can copy into
your own project — no library to install, just configuration.

| Path | What it shows |
|---|---|
| [`claude-desktop/`](claude-desktop/) | A `claude_desktop_config.json` snippet that registers `sign mcp serve` as an MCP server Claude Desktop can call into. |
| [`langchain/`](langchain/) | A 60-line Python wrapper exposing each MCP tool as a langchain `Tool` so an agent can drive `sign-cli` from a langchain pipeline. |

## Have an integration to share?

PRs welcome. Each integration should:

- Be the smallest possible thing that runs end-to-end.
- Use the documented public surfaces (`sign mcp serve`, `sign serve`, the JSON catalog) — don't reach into internals.
- Default to least privilege: `--read-only true` and `--tool` allow-listing where it makes sense.
