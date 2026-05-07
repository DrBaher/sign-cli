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
    ],
  },
  {
    command: "request list",
    summary: "List recent requests from local SQLite.",
    flags: [
      { name: "--provider", description: "Filter by provider." },
      { name: "--status", description: "Filter by status." },
      { name: "--limit", description: "Cap rows (default 100)." },
    ],
  },
  {
    command: "request show",
    summary: "Enriched snapshot: request, approvals, signedBy[], nextSteps[].",
    flags: [{ name: "--request-id", required: true, description: "Request id." }],
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
  // Audit + bundles
  {
    command: "audit show",
    summary: "List all audit events for a request.",
  },
  {
    command: "audit verify",
    summary: "Verify the audit chain's hash linkage; exits 3 on a break.",
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
    command: "mcp serve",
    summary: "Stdio Model Context Protocol server (tools + resources for LLM agents).",
  },
  {
    command: "serve",
    summary: "HTTP REST surface mirroring the MCP tools for non-MCP clients. Bearer auth via --auth-token or SIGN_HTTP_AUTH_TOKEN.",
    flags: [
      { name: "--port", description: "Port to bind (default 4000)." },
      { name: "--bind", description: "Bind address (default 127.0.0.1)." },
      { name: "--auth-token", description: "Required Bearer token; falls back to SIGN_HTTP_AUTH_TOKEN env var." },
    ],
  },
  {
    command: "mcp tools",
    summary: "Print the MCP tool catalog without starting the server.",
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
