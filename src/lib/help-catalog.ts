// Single source of truth for CLI command summaries and flags. Used by:
//   sign --help                  → top-level command index
//   sign <cmd> [<sub>] --help    → focused per-command help
//   sign --catalog json          → machine-readable index
//   sign examples                → walkthrough snippets

// Bumped manually on each release; mirrored in package.json.
export const SIGN_CLI_VERSION = "0.5.0";

export type FlagSpec = {
  name: string;          // e.g. "--request-id" or "--token"
  required?: boolean;
  description: string;
};

export type CommandSpec = {
  command: string;       // e.g. "request create" or "signer policy run-all"
  summary: string;
  flags?: FlagSpec[];
  example?: string;
};

export const HELP_CATALOG: CommandSpec[] = [
  // Top-level lifecycle
  {
    command: "init",
    summary: "Interactive .env wizard for hosted-provider credentials.",
    flags: [{ name: "--out", description: "Path to write the generated .env (defaults to ./.env)." }],
  },
  {
    command: "doctor",
    summary: "Print environment + key-detection report.",
  },
  {
    command: "doctor account-check",
    summary: "Live API check for the selected provider's account quota / configuration.",
    flags: [{ name: "--provider", description: "dropbox | docusign | signwell | local." }],
  },
  {
    command: "doctor providers",
    summary: "JSON capability matrix for all four providers.",
  },
  {
    command: "demo",
    summary: "Run the local-provider end-to-end demo: create + send + sign + bundle.",
    flags: [
      { name: "--document", description: "PDF to sign (optional; demo generates one if omitted)." },
      { name: "--out", description: "Bundle output directory (defaults to ./demo-bundle)." },
    ],
  },
  {
    command: "selftest",
    summary: "In-process end-to-end smoke against a scratch DB: create → send → sign → fetch-final → verify-signed-pdf → audit verify → request receipt → verify-receipt. Exits 3 on any failure; drop-in for deploy health checks.",
    flags: [{ name: "--keep-workspace", description: "true to keep the temp directory for inspection (default cleans up)." }],
  },
  // Request creation
  {
    command: "request create",
    summary: "Create a signing request from CLI flags or a JSON spec file.",
    flags: [
      { name: "--title", description: "Document title." },
      { name: "--document", description: "Path to a PDF (repeatable for multi-doc)." },
      { name: "--signer", description: "Signer spec name:X,email:Y,order:N (repeatable)." },
      { name: "--field", description: "Field placement signer:N,doc:N,page:N,x:N,y:N,type:signature." },
      { name: "--prefill", description: "Template prefill name:K,value:V[,signer:N]." },
      { name: "--token-ttl-minutes", description: "Token lifetime in minutes (default 60)." },
      { name: "--auto-approve", description: "true to skip the approval gate (default false)." },
      { name: "--provider", description: "dropbox | docusign | signwell | local." },
      { name: "--spec", description: "Load all of the above from a JSON file." },
      { name: "--param", description: "key=value substituted into spec via {{key}} (repeatable)." },
      { name: "--idempotency-key", description: "Same key + same args returns the cached result instead of re-running." },
    ],
    example:
      `sign request create --title "Mutual NDA" --document ./nda.pdf \\\n` +
      `  --signer name:Alice,email:alice@example.com,order:1 \\\n` +
      `  --signer name:Bob,email:bob@example.com,order:2 \\\n` +
      `  --provider local --auto-approve true`,
  },
  {
    command: "request from-template",
    summary: "Create a request from a provider-side template id.",
    flags: [
      { name: "--template-id", required: true, description: "Provider template id." },
      { name: "--signer", description: "role:Buyer,name:Alice,email:alice@example.com,order:1." },
      { name: "--prefill", description: "Template prefill name:K,value:V[,signer:N]." },
    ],
  },
  {
    command: "request run-email",
    summary: "Convenience: create + send in one step. Auto-approves.",
  },
  {
    command: "request send",
    summary: "Dispatch a created request to the provider.",
    flags: [
      { name: "--request-id", required: true, description: "Request id." },
      { name: "--force", description: "Resend even if provider_request_id is already set." },
    ],
  },
  {
    command: "request send-embedded",
    summary: "Send via the provider's embedded-signing flow.",
  },
  {
    command: "request sign-url",
    summary: "Fetch a per-signer sign URL.",
  },
  {
    command: "request launch-embedded",
    summary: "Generate an HTML launcher that wraps the embedded sign URL.",
  },
  {
    command: "request fetch-final",
    summary: "Download the completed PDF and persist to artifacts.",
  },
  {
    command: "request status",
    summary: "Poll the provider once for current status. Pass --watch true to poll until terminal (same flags as `request watch`).",
    flags: [
      { name: "--request-id", required: true, description: "Request id." },
      { name: "--watch", description: "true to keep polling; same flags + exit codes as `request watch`." },
      { name: "--interval-ms", description: "(--watch true) Poll interval; or --interval-seconds." },
      { name: "--timeout-ms", description: "(--watch true) Stop after N ms; or --timeout-seconds." },
      { name: "--fetch-final", description: "(--watch true) true to download the signed PDF on completion." },
      { name: "--out", description: "(--watch true) Path to write the signed PDF." },
    ],
  },
  {
    command: "request watch",
    summary: "Poll until terminal (completed/declined/expired/canceled) or timeout.",
  },
  {
    command: "request remind",
    summary: "Re-notify a pending signer (provider-dependent).",
  },
  {
    command: "request cancel",
    summary: "Cancel/void at the provider. Requires --yes true.",
  },
  {
    command: "request bulk",
    summary: "One-request-per-row from a CSV. Optionally emits a tokens roster (--emit-tokens ./tokens.json) compatible with `signer policy run-all --tokens-file …`.",
    flags: [
      { name: "--csv", required: true, description: "CSV file with name + email columns." },
      { name: "--document", description: "PDF to attach (repeatable for multi-doc)." },
      { name: "--title", description: "Title template; supports {{email}}, {{name}}, {{row}}." },
      { name: "--emit-tokens", description: "Write a per-row tokens roster to this path (skipped from stdout)." },
      { name: "--ndjson", description: "true to emit one JSON object per result row (plus a final summary line) — pipe-friendly for jq/grep/streaming consumers." },
    ],
  },
  {
    command: "request bulk-resend",
    summary: "Re-issue signer tokens en masse from a CSV roster. Rows: request_id,signer_email[,token_ttl_minutes]. Per-row failures (signer-not-recipient, already-signed, missing approval) are captured so the batch keeps going. Exits 3 if any row failed.",
    flags: [
      { name: "--csv", required: true, description: "CSV with request_id + signer_email columns." },
      { name: "--token-ttl-minutes", description: "Default TTL for new tokens (default 30); overridable per row." },
      { name: "--emit-tokens", description: "Write a tokens roster to this path (the canonical artifact; stdout strips raw tokens)." },
      { name: "--ndjson", description: "true to emit one JSON object per result row (plus a final summary line)." },
    ],
  },
  {
    command: "request list",
    summary: "List recent requests from local SQLite. JSON by default; --format table renders a fixed-width grep-able view.",
    flags: [
      { name: "--provider", description: "Filter by provider." },
      { name: "--status", description: "Filter by status." },
      { name: "--since", description: "Only rows created at or after this ISO 8601 timestamp." },
      { name: "--limit", description: "Cap rows (default 100, max 500)." },
      { name: "--format", description: "json (default) or table." },
    ],
  },
  {
    command: "request diff",
    summary: "Compare two requests (handy for repeat counterparties): title/status/provider deltas, added/removed/same signers, and whether the document hash changed. Exits 0 on identical, 1 on any diff.",
    flags: [
      { name: "--before", required: true, description: "Earlier request id." },
      { name: "--after", required: true, description: "Later request id." },
    ],
  },
  {
    command: "request rerun-policy",
    summary: "Re-evaluate a stored request against a (possibly updated) policy spec. Pure read — no state mutation, no signer token required. Companion to `signer policy try` for in-flight or completed requests.",
    flags: [
      { name: "--request-id", required: true, description: "Request to re-evaluate." },
      { name: "--spec", required: true, description: "Path to policy.json." },
      { name: "--signer-email", description: "Override signer email (defaults to first recipient)." },
    ],
  },
  {
    command: "request show",
    summary: "Enriched snapshot: request, approvals, signedBy[], nextSteps[]. With --metrics true, also returns counters (events, fetches, webhook replays, time-to-first-sign, time-to-complete).",
    flags: [
      { name: "--request-id", required: true, description: "Request id." },
      { name: "--metrics", description: "true to include the metrics rollup." },
    ],
  },
  {
    command: "request verify-signed-pdf",
    summary: "Inspect the embedded PKCS#7 signature(s) of a final PDF.",
  },
  {
    command: "request receipt",
    summary: "Audit-export bundle plus a detached manifest.sig + manifest.cert.pem.",
    flags: [
      { name: "--request-id", required: true, description: "Request id." },
      { name: "--out", required: true, description: "Output directory." },
    ],
  },
  {
    command: "request verify-receipt",
    summary: "Standalone verifier for a request receipt bundle (no DB required).",
    flags: [
      { name: "--bundle", required: true, description: "Path to a directory produced by `request receipt`." },
      { name: "--html", description: "Also write a static HTML report to this path (printable, openable by non-CLI recipients)." },
    ],
    example: "sign request verify-receipt --bundle ./receipt/ --html ./receipt/report.html",
  },
  // Signer-side
  {
    command: "approve",
    summary: "Spend the signer's approval token (the requester pre-flight gate).",
    flags: [
      { name: "--request-id", required: true, description: "Request id." },
      { name: "--token", required: true, description: "Per-signer token from request create." },
    ],
  },
  {
    command: "sign",
    summary: "Sign a local-provider request as the holder of --token.",
    flags: [
      { name: "--request-id", required: true, description: "Request id." },
      { name: "--token", required: true, description: "Per-signer token." },
      { name: "--require-hash", description: "Pre-sign safety: expected document SHA-256." },
      { name: "--require-title", description: "Pre-sign safety: regex the title must match." },
      { name: "--require-signer-email", description: "Pre-sign safety: expected signer email." },
      { name: "--idempotency-key", description: "Same key returns the cached SignerSignResult instead of double-signing on retry." },
    ],
    example: `sign sign --request-id req_abc --token alice-tok-... \\\n  --require-hash 9c2b... --require-title "^Mutual NDA$"`,
  },
  {
    command: "signer list",
    summary: "Pending inbox; entries include tokens[] with expiresSoon flags.",
    flags: [{ name: "--signer-email", description: "Filter to a single signer." }],
  },
  {
    command: "signer fetch-document",
    summary: "Read the unsigned PDF; records request.signer_fetched_document.",
  },
  {
    command: "signer decline",
    summary: "Decline as the token holder.",
  },
  {
    command: "signer reissue-token",
    summary: "Mint a new per-signer token and invalidate the old one.",
  },
  {
    command: "signer watch",
    summary: "Long-running tail of the signer inbox; emits new entries as they appear.",
    flags: [
      { name: "--signer-email", description: "Filter the inbox to one signer." },
      { name: "--exit-on-first", description: "true to exit on the first new entry (otherwise runs forever / until --timeout-seconds)." },
      { name: "--interval-seconds", description: "Belt-and-suspenders poll interval (default 1s)." },
      { name: "--timeout-seconds", description: "Exit code 4 after this many seconds with no new entry." },
    ],
  },
  {
    command: "signer policy run",
    summary: "Apply a declarative policy spec to a single request.",
  },
  {
    command: "signer policy run-all",
    summary: "Loop the inbox and apply a policy to every request the agent has a token for.",
  },
  {
    command: "signer policy try",
    summary: "Offline tester for a policy spec — supply a synthetic context and print the decision without touching state.",
    flags: [
      { name: "--spec", required: true, description: "Path to policy.json." },
      { name: "--title", description: "Title for the synthetic context (or use --snapshot)." },
      { name: "--document-sha256", description: "SHA-256 for the synthetic context (or use --snapshot)." },
      { name: "--signer-email", description: "Signer email for the synthetic context (or use --snapshot)." },
      { name: "--snapshot", description: "Path to a request show JSON file; pulls title/sha256/signer from it." },
    ],
    example:
      `sign signer policy try --spec ./policy.json \\\n` +
      `  --title "Mutual NDA" --document-sha256 abc... --signer-email alice@example.com`,
  },
  {
    command: "signer policy lint",
    summary: "Static checks for a policy spec: invalid regexes, unreachable rules after match: \"any\", redundant rules with the same action as a broader earlier rule, decline actions without a reason. Exits 3 if errors are present; warnings are non-fatal.",
    flags: [
      { name: "--spec", required: true, description: "Path to policy.json." },
    ],
    example: `sign signer policy lint --spec ./policy.json`,
  },
  {
    command: "signer policy diff",
    summary: "Compare two policy specs against the same context(s) and report which rows would flip action. Pure preview — never touches request state.",
    flags: [
      { name: "--before", required: true, description: "Path to the current/baseline policy.json." },
      { name: "--after", required: true, description: "Path to the proposed policy.json." },
      { name: "--snapshot", description: "Diff a single context loaded from a request show JSON file." },
      { name: "--inbox", description: "true to diff against every pending inbox row (filtered by --signer-email)." },
      { name: "--signer-email", description: "Inbox filter / fallback signer for the synthetic context." },
    ],
    example:
      `sign signer policy diff --before ./policy.v1.json --after ./policy.v2.json \\\n` +
      `  --inbox true --signer-email alice@example.com`,
  },
  // Audit + bundles
  {
    command: "audit show",
    summary: "List all audit events for a request. JSON by default; --format csv emits an RFC 4180 CSV (CRLF line endings, quoted payloads) for spreadsheet-driven compliance review.",
    flags: [
      { name: "--request-id", required: true, description: "Request to dump." },
      { name: "--format", description: "json (default) or csv." },
    ],
  },
  {
    command: "audit verify",
    summary: "Verify the audit chain's hash linkage; exits 3 on a break.",
  },
  {
    command: "audit search",
    summary: "Log-style filter across the full audit_events table. All flags are AND'd; --payload-contains does a substring match on the JSON-serialized payload.",
    flags: [
      { name: "--request-id", description: "Scope to a single request." },
      { name: "--event-type", description: "Exact event_type match (e.g. request.signed)." },
      { name: "--since", description: "ISO 8601 lower bound on created_at." },
      { name: "--until", description: "ISO 8601 upper bound on created_at." },
      { name: "--payload-contains", description: "Substring search across the JSON payload — handy for grepping an email or token hint." },
      { name: "--limit", description: "Cap rows (default 1000, max 5000)." },
    ],
  },
  {
    command: "audit scan",
    summary: "Verify the audit chain for every request in the local DB at once. Exits 3 if any chain is broken.",
    flags: [
      { name: "--provider", description: "Filter by provider (dropbox/docusign/signwell/local)." },
      { name: "--status", description: "Filter by request status." },
      { name: "--limit", description: "Cap rows scanned (default 1000, max 5000)." },
    ],
  },
  {
    command: "audit watch",
    summary: "Long-running tamper alarm: re-verifies the chain on every audit-event notification (or every --interval-seconds). Exits 3 on first break, 4 on timeout.",
    flags: [
      { name: "--request-id", description: "Watch a single request_id (default: scan all requests)." },
      { name: "--interval-seconds", description: "Belt-and-suspenders poll interval (default 5s)." },
      { name: "--timeout-seconds", description: "Stop after N seconds with no break detected." },
    ],
  },
  {
    command: "audit timestamp",
    summary: "Append an RFC 3161 timestamp to the chain head.",
  },
  {
    command: "audit export",
    summary: "Bundle audit.json + signed.pdf + audit.tsr + manifest.json.",
  },
  {
    command: "audit export-jsonld",
    summary: "Export the audit chain as a JSON-LD document with a stable @context (interoperable with external auditors / SBOM-style tooling).",
    flags: [
      { name: "--request-id", required: true, description: "Request id." },
      { name: "--out", required: true, description: "Output path for audit.jsonld." },
    ],
  },
  {
    command: "audit sign-head",
    summary: "Sign the latest audit chain hash with the local signer key. Produces a small standalone proof.",
    flags: [
      { name: "--request-id", required: true, description: "Request id." },
      { name: "--out", description: "Optional path to write the proof JSON." },
    ],
  },
  {
    command: "audit verify-head",
    summary: "Verify a head-proof JSON file produced by `audit sign-head`.",
    flags: [{ name: "--proof", required: true, description: "Path to the proof JSON." }],
  },
  {
    command: "audit issue-receipts",
    summary: "Bulk-issue one signed receipt-bundle per matching request (filters: --provider, --status, --limit). Exits 3 if any row failed.",
    flags: [
      { name: "--out", required: true, description: "Parent directory; one subdir per request id." },
      { name: "--provider", description: "Only consider requests for this provider." },
      { name: "--status", description: "Only consider requests with this status (e.g. completed)." },
      { name: "--limit", description: "Cap rows processed (default 1000, max 5000)." },
      { name: "--ndjson", description: "true to emit one JSON object per result row (plus a final summary line)." },
    ],
  },
  // Webhooks
  {
    command: "webhook verify",
    summary: "Verify a webhook payload's signature without ingesting.",
  },
  {
    command: "webhook ingest",
    summary: "Verify + persist a webhook payload (writes signedBy[] for hosted providers).",
  },
  {
    command: "webhook listen",
    summary: "Run an HTTP receiver that ingests provider callbacks. Pass --pretty true to also tail audit events as human-readable lines on stderr.",
    flags: [
      { name: "--provider", description: "dropbox | signwell | docusign." },
      { name: "--port", description: "HTTP port (default 3000)." },
      { name: "--path", description: "URL path the provider POSTs to." },
      { name: "--pretty", description: "Tail audit events as human-readable lines on stderr." },
    ],
  },
  // Infra
  {
    command: "db backup",
    summary: "Snapshot SQLite via VACUUM INTO.",
  },
  {
    command: "db verify",
    summary: "PRAGMA integrity_check; exits 3 on failure.",
  },
  {
    command: "db migrate",
    summary: "Apply pending versioned migrations from src/lib/migrations.ts. Migrations also run automatically on every openDatabase; this command is for one-shot ops + dry-run inspection.",
    flags: [
      { name: "--dry-run", description: "Print the pending queue without applying anything." },
    ],
  },
  {
    command: "db indexes",
    summary: "Ops introspection over the SQLite catalog: list every index (with table, columns, unique/partial flags, original CREATE INDEX SQL); optionally EXPLAIN QUERY PLAN for a SQL string; optionally suggest under-indexed tables.",
    flags: [
      { name: "--explain", description: "SQL string. Runs EXPLAIN QUERY PLAN and includes the steps in the response." },
      { name: "--suggest", description: "true to include a suggestions[] array — user tables with > --suggest-threshold rows and zero user-created indexes." },
      { name: "--suggest-threshold", description: "Row count above which a table is considered for suggestions (default 1000)." },
    ],
  },
  {
    command: "db indexes-postgres",
    summary: "Postgres companion to `db indexes`. Reads pg_indexes / pg_class for the active connection, runs EXPLAIN (FORMAT JSON), and uses pg_class.reltuples for cheap row-count estimates in the suggestions heuristic.",
    flags: [
      { name: "--pg-url", description: "postgres://… connection string (defaults to SIGN_PG_URL)." },
      { name: "--schema", description: "Schema to scan (default public)." },
      { name: "--explain", description: "SQL string. Runs EXPLAIN (FORMAT JSON) and includes the plan tree." },
      { name: "--suggest", description: "true to include a suggestions[] array of under-indexed tables (uses pg_class.reltuples; run ANALYZE first if numbers look stale)." },
      { name: "--suggest-threshold", description: "Row-estimate threshold (default 1000)." },
    ],
  },
  {
    command: "db migrate-postgres",
    summary: "One-shot Postgres bootstrap: connects to --pg-url, creates the ported schema (CREATE TABLE IF NOT EXISTS) and the audit_events append-only triggers via PL/pgSQL. Idempotent — safe to re-run.",
    flags: [
      { name: "--pg-url", description: "postgres://… connection string (defaults to SIGN_PG_URL)." },
    ],
  },
  {
    command: "db backend",
    summary: "Report the active storage backend (sqlite | postgres).",
    flags: [{ name: "--backend", description: "Override SIGN_DB_BACKEND for this call." }],
  },
  {
    command: "mcp serve",
    summary: "Stdio Model Context Protocol server (tools + resources for LLM agents).",
  },
  {
    command: "serve",
    summary: "HTTP REST surface mirroring the MCP tools for non-MCP clients. Bearer auth via --auth-token or SIGN_HTTP_AUTH_TOKEN. --tls-cert + --tls-key flips to https.",
    flags: [
      { name: "--port", description: "Port to bind (default 4000)." },
      { name: "--bind", description: "Bind address (default 127.0.0.1)." },
      { name: "--auth-token", description: "Required Bearer token; falls back to SIGN_HTTP_AUTH_TOKEN env var." },
      { name: "--tls-cert", description: "TLS server certificate PEM path (with --tls-key, listens on https)." },
      { name: "--tls-key", description: "TLS private key PEM path." },
      { name: "--tls-ca", description: "Optional CA bundle PEM (forwarded to https.createServer)." },
      { name: "--web-demo", description: "true to serve the bundled dashboard from fixtures/web-demo, or a path to your own static dir. Mounts at /web-demo/index.html, same-origin (no CORS)." },
    ],
  },
  {
    command: "mcp tools",
    summary: "Print the MCP tool catalog without starting the server. Each tool ships an inputSchema; tools that return structured responses also ship an outputSchema so generic agent loops can validate without per-tool code.",
    flags: [
      { name: "--format", description: "json (default) or markdown — markdown renders a docs page including input + output schemas." },
    ],
  },
  {
    command: "metrics show",
    summary: "Render Prometheus text from the local DB and write it to stdout. Same body as GET /v1/metrics, no server required.",
  },
  {
    command: "metrics ship",
    summary: "Long-running pusher that POSTs the Prometheus text to a remote endpoint on a cadence. Exits cleanly on SIGINT/SIGTERM. Errors don't crash the loop — backs off (capped at 10× the base interval) instead.",
    flags: [
      { name: "--url", required: true, description: "Endpoint that accepts POST text/plain (e.g. a Prometheus pushgateway-equivalent)." },
      { name: "--bearer", description: "Optional Bearer token; sent as Authorization header." },
      { name: "--header", description: "Repeatable. KEY=VALUE pairs added to each request." },
      { name: "--interval-seconds", description: "Cadence between pushes (default 30)." },
      { name: "--max-pushes", description: "Stop after this many pushes — useful for scripted runs." },
    ],
  },
  {
    command: "completion",
    summary: "Print a shell completion script (bash | zsh | fish).",
  },
  {
    command: "examples",
    summary: "Curated walkthrough snippets for the most common flows.",
  },
];

export function findCommand(query: string): CommandSpec | null {
  const normalized = query.trim().replace(/\s+/gu, " ");
  return HELP_CATALOG.find((entry) => entry.command === normalized) ?? null;
}

export function formatTopLevelHelp(): string {
  const lines: string[] = ["sign — consent-gated, auditable e-sign CLI", ""];
  // Group by first word for readability.
  const buckets = new Map<string, CommandSpec[]>();
  for (const cmd of HELP_CATALOG) {
    const root = cmd.command.split(" ")[0];
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root)!.push(cmd);
  }
  for (const [root, list] of buckets) {
    lines.push(`# ${root}`);
    for (const cmd of list) {
      lines.push(`  sign ${cmd.command.padEnd(28)}  ${cmd.summary}`);
    }
    lines.push("");
  }
  lines.push("Run `sign <command> --help` for focused help on any command.");
  lines.push("Run `sign --catalog json` for a machine-readable catalog.");
  return lines.join("\n");
}

export function formatCommandHelp(spec: CommandSpec): string {
  const lines: string[] = [`sign ${spec.command}`, "", spec.summary];
  if (spec.flags && spec.flags.length > 0) {
    lines.push("", "Flags:");
    for (const flag of spec.flags) {
      const tag = flag.required ? " (required)" : "";
      lines.push(`  ${flag.name.padEnd(28)}  ${flag.description}${tag}`);
    }
  }
  if (spec.example) {
    lines.push("", "Example:");
    for (const line of spec.example.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  return lines.join("\n");
}

export function buildCatalogJson(): { commands: Array<Pick<CommandSpec, "command" | "summary" | "flags" | "example">> } {
  return {
    commands: HELP_CATALOG.map((cmd) => ({
      command: cmd.command,
      summary: cmd.summary,
      ...(cmd.flags ? { flags: cmd.flags } : {}),
      ...(cmd.example ? { example: cmd.example } : {}),
    })),
  };
}

export const EXAMPLE_WALKTHROUGHS: Array<{ title: string; commands: string[] }> = [
  {
    title: "Local-provider sanity check",
    commands: [
      "sign demo --out ./demo-bundle",
      "ls demo-bundle/  # signed.pdf, audit.json, manifest.json",
    ],
  },
  {
    title: "Two-signer NDA, agent-as-signer",
    commands: [
      `sign request create --title "Mutual NDA" --document ./nda.pdf \\
  --signer name:Alice,email:alice@example.com,order:1 \\
  --signer name:Bob,email:bob@example.com,order:2 \\
  --provider local --auto-approve true`,
      "sign request send --request-id <id> --provider local",
      "# requester DMs each signer their token from tokens[]",
      "",
      "# Alice's agent:",
      "sign signer list --signer-email alice@example.com",
      "sign signer fetch-document --request-id <id> --token alice-tok-... --out ./nda-review.pdf",
      "sign sign --request-id <id> --token alice-tok-... \\",
      `  --require-hash <expected-sha256> --require-title "^Mutual NDA$"`,
    ],
  },
  {
    title: "Declarative policy enforcement",
    commands: [
      "cat > policy.json <<'JSON'",
      `{"expectations":{"titleMatches":"^Mutual NDA"},"rules":[{"match":"any","action":"sign"}]}`,
      "JSON",
      "sign signer policy run --request-id <id> --token alice-tok-... --spec ./policy.json",
    ],
  },
  {
    title: "Cryptographic receipt for compliance",
    commands: [
      "sign request receipt --request-id <id> --out ./receipt/",
      `openssl dgst -sha256 \\
  -verify <(openssl x509 -pubkey -noout -in receipt/manifest.cert.pem) \\
  -signature receipt/manifest.sig receipt/manifest.json`,
    ],
  },
  {
    title: "MCP server for an LLM agent",
    commands: [
      'export SIGN_LOCAL_AUTOCOMPLETE=false',
      "sign mcp serve  # stdio; pipe a Claude Desktop / Code session here",
      "sign mcp tools  # one-shot tool catalog (no server)",
    ],
  },
  {
    title: "Spec template + variable substitution",
    commands: [
      "sign request create --spec ./fixtures/request-spec.example.json \\",
      "  --param counterparty=alice@example.com --param name=Alice",
    ],
  },
  {
    title: "Webhook ingestion (hosted providers)",
    commands: [
      "sign webhook listen --provider signwell --port 3000",
      "# in another terminal:",
      "sign request show --request-id <id>  # signedBy[] now reflects hosted-provider state",
    ],
  },
];

export function formatExamples(): string {
  const lines: string[] = ["sign — common flow walkthroughs", ""];
  for (const example of EXAMPLE_WALKTHROUGHS) {
    lines.push(`# ${example.title}`);
    for (const command of example.commands) {
      lines.push(command);
    }
    lines.push("");
  }
  return lines.join("\n");
}
