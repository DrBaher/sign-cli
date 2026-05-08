"""sign-cli langchain tool adapter.

Spawns `sign mcp serve` once and exposes each MCP tool as a langchain
`Tool`. The MCP server is the source of truth for tool names + schemas;
this adapter is purely a transport.

Usage:

    from sign_cli_tools import build_sign_cli_tools

    tools = build_sign_cli_tools(
        sign_cli_path="/abs/path/to/sign-cli",
        read_only=True,
        allowed_tools=["signer_list", "request_show", "audit_verify"],
    )
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from queue import Queue, Empty
from typing import Any, Dict, List, Optional

# Optional langchain import — kept lazy so the file is also useful as a
# reference implementation if the caller is on a different agent
# framework.
try:
    from langchain_core.tools import Tool  # type: ignore
except ImportError:  # pragma: no cover
    Tool = None  # type: ignore


class _McpClient:
    """Minimal stdio JSON-RPC 2.0 client. One subprocess, one stdin/stdout
    pump, ID-keyed response queues. Blocks the calling thread per tool
    call — fine for a langchain Tool that's already synchronous."""

    def __init__(self, args: List[str], env: Optional[Dict[str, str]] = None):
        self.proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, **(env or {})},
            text=True,
            bufsize=1,
        )
        self._next_id = 0
        self._waiters: Dict[int, Queue] = {}
        self._reader = threading.Thread(target=self._pump_stdout, daemon=True)
        self._reader.start()

    def _pump_stdout(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if isinstance(msg, dict) and "id" in msg and msg["id"] in self._waiters:
                self._waiters[msg["id"]].put(msg)

    def call(self, method: str, params: Optional[Dict[str, Any]] = None, timeout: float = 30.0) -> Dict[str, Any]:
        self._next_id += 1
        rid = self._next_id
        q: Queue = Queue()
        self._waiters[rid] = q
        body = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            body["params"] = params
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(body) + "\n")
        self.proc.stdin.flush()
        try:
            return q.get(timeout=timeout)
        finally:
            self._waiters.pop(rid, None)

    def close(self) -> None:
        try:
            assert self.proc.stdin is not None
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.wait(timeout=5)


def build_sign_cli_tools(
    sign_cli_path: str,
    read_only: bool = True,
    allowed_tools: Optional[List[str]] = None,
    capability: Optional[List[str]] = None,
    emit_events: Optional[str] = None,
    emit_events_redact: bool = True,
    db_path: Optional[str] = None,
) -> List[Any]:
    """Spawn `sign mcp serve` and return one langchain `Tool` per
    advertised MCP tool.

    Arguments:
        sign_cli_path:        Absolute path to the cloned + built sign-cli repo.
        read_only:            Pass --read-only true (recommended).
        allowed_tools:        List of tool names to whitelist via --tool.
        capability:           List from {"tools","resources","prompts"};
                              defaults to ["tools"] when None.
        emit_events:          Path to NDJSON replay log (recommended for prod).
        emit_events_redact:   Mask token-shaped fields in the replay log.
        db_path:              SIGN_DB_PATH for the spawned process.

    Returns:
        List of langchain Tool instances. Empty list if langchain isn't
        installed (the spawn still happens; you can drive _McpClient
        directly).
    """
    cli_js = os.path.join(sign_cli_path, "dist", "cli.js")
    args = ["node", cli_js, "mcp", "serve"]
    if read_only:
        args += ["--read-only", "true"]
    for cap in capability or ["tools"]:
        args += ["--capability", cap]
    for tool in allowed_tools or []:
        args += ["--tool", tool]
    if emit_events:
        args += ["--emit-events", emit_events]
        if emit_events_redact:
            args += ["--emit-events-redact", "true"]

    env: Dict[str, str] = {}
    if db_path:
        env["SIGN_DB_PATH"] = db_path

    client = _McpClient(args, env=env)
    client.call("initialize")
    listed = client.call("tools/list").get("result", {}).get("tools", [])

    if Tool is None:
        # Caller can still use the client directly via call("tools/call", ...)
        return []

    tools = []
    for entry in listed:
        name = entry.get("name", "")
        description = entry.get("description", "")

        def make_runner(tool_name: str):
            def run(args_text: str) -> str:
                # langchain passes a single string; assume JSON.
                try:
                    arguments = json.loads(args_text) if args_text.strip() else {}
                except json.JSONDecodeError:
                    arguments = {"_raw": args_text}
                resp = client.call("tools/call", {"name": tool_name, "arguments": arguments})
                content = (resp.get("result") or {}).get("content") or []
                if content and isinstance(content[0], dict) and "text" in content[0]:
                    return content[0]["text"]
                return json.dumps(resp)
            return run

        tools.append(Tool(name=name, description=description, func=make_runner(name)))
    return tools
