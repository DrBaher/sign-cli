# langchain integration starter

A minimal Python wrapper that exposes each `sign mcp serve` tool as a
[langchain](https://python.langchain.com/) `Tool`. The agent gets the
typed catalog without you having to mirror it by hand.

## Install

```bash
pip install langchain  # or langchain-core
```

You also need `sign-cli` built locally (`npm install && npm run build`).

## Use

```python
from sign_cli_tools import build_sign_cli_tools

tools = build_sign_cli_tools(
    sign_cli_path="/absolute/path/to/sign-cli",
    read_only=True,                 # disable sign + signer_decline at the server
    allowed_tools=["signer_list", "request_show", "audit_verify"],
)

# Pass `tools` to your AgentExecutor / create_react_agent / etc.
```

The full wrapper is in [`sign_cli_tools.py`](./sign_cli_tools.py).

## What it does

1. Spawns one `sign mcp serve` subprocess on stdio (with the same
   `--read-only` / `--tool` / `--capability` / `--emit-events` knobs the
   Claude Desktop integration uses).
2. Sends `initialize`, then `tools/list` to fetch the typed catalog.
3. Builds a langchain `Tool` per advertised tool, with the `inputSchema`
   passed through as the function signature.
4. Returns the list of tools.

When you run a tool, the wrapper calls `tools/call` over the existing
stdio connection and parses `content[0].text` as JSON.

## Why this is small

The wrapper deliberately doesn't replicate any logic from `sign-cli`.
The MCP server is the source of truth for tool names, schemas, and
behavior — the wrapper is just a transport adapter.
