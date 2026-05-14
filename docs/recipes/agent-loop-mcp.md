# Agent loop over MCP

Drive the CLI from an LLM agent over JSON-RPC. The same surface that
powers the HTTP API (`sign serve`) is also exposed as a stdio MCP server,
so any client that speaks Model Context Protocol can read state and (with
permission) act.

## What the agent sees

**Don't hardcode this list.** Query it at startup with `sign mcp tools` —
the catalog grows; this is a snapshot, not a contract.

```bash
sign mcp tools --format markdown   # human-readable catalog with input + output schemas
sign mcp tools | jq '.tools[].name'
# Read-only inspection
# "signer_list"
# "signer_fetch_document"
# "request_show"
# "request_status"
# "audit_verify"
# "audit_scan"
# "request_watch"
# "pdf_detect_signature_field"
# "pdf_detect_date_field"
# "profile_list"
# "profile_show"
# Mutating (gated by --read-only true)
# "sign"
# "signer_decline"
# "signer_reissue_token"
# "request_receipt"
# "pdf_stamp_text"
# "preview"
# "document"
```

Each tool ships a JSON-Schema `inputSchema`, `outputSchema`, and (for
`request_watch`) a `progressSchema` for streamed updates.

## 0. Start a strict, observe-only server

```bash
sign mcp serve \
  --capability tools \
  --tool signer_list --tool request_show --tool audit_verify \
  --read-only true \
  --emit-events ./mcp-audit.ndjson \
  --emit-events-redact true
```

What each flag buys you:

| flag | effect |
|---|---|
| `--capability tools` | hide resources/prompts surfaces — agent can't probe them |
| `--tool …` (repeatable) | only the named tools are advertised; others return UNKNOWN_TOOL |
| `--read-only true` | block every mutating tool: sign, signer_decline, signer_reissue_token, request_receipt, pdf_stamp_text, preview, document (already excluded by --tool, belt-and-suspenders) |
| `--emit-events …` | append every JSON-RPC message to NDJSON for replay |
| `--emit-events-redact true` | mask tokens in the log so it's safe for a SIEM |

## 1. Drive the loop

A minimal client (Node, Python, anything) just needs to:

```jsonc
// Send (newline-delimited):
{ "jsonrpc": "2.0", "id": 1, "method": "initialize" }
{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
{ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": { "name": "signer_list", "arguments": { "signer_email": "alice@example.com" } } }
```

`tools/call` results come back wrapped in MCP's `content[0].text`
envelope:

```jsonc
{ "jsonrpc": "2.0", "id": 3, "result": {
    "content": [ { "type": "text", "text": "[ {\"requestId\": …} ]" } ]
} }
```

Parse `content[0].text` to get the actual return value (it matches the
`outputSchema` advertised in `tools/list`).

## 2. Use `request_watch` for long-running reads

`request_watch` returns the final terminal status, but if the client
includes a `_meta.progressToken` in `params`, it gets a
`notifications/progress` per poll:

```jsonc
{ "jsonrpc": "2.0", "method": "notifications/progress",
  "params": { "progressToken": "<token>", "progress": 3, "message": "sent" } }
```

Schema in `tools/list`'s `progressSchema`. Use this when wiring a
long-running agent loop into UI updates.

## 3. Compose with `sign signer policy run-watch`

If your agent should *act* on new entries (sign or decline by policy), the
better tool is:

```bash
sign signer policy run-watch \
  --tokens-file ./tokens.json \
  --spec ./policy.json \
  --report ./decisions.ndjson
```

The loop applies your policy spec to every new inbox entry. Pair with
`mcp serve` for inspection-style queries the agent makes between loops.

## What's next

- `sign mcp tools --format markdown` produces a docs page you can paste into
  the agent's system prompt as the tool catalog.
- The HTTP equivalent is `sign serve` (same handlers behind REST endpoints,
  Bearer auth, optional rate-limit + read-only).
- The replay log from `--emit-events` is the canonical record — keep it
  with the request bundles for an end-to-end audit trail.
