import { SignCliError } from "./sign-error.js";

export type McpPromptArgument = {
  name: string;
  description: string;
  required?: boolean;
};

export type McpPromptDefinition = {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
  // Builds the messages[] returned by prompts/get. Receives the raw arg map
  // (already validated against the required[] above).
  build: (args: Record<string, string>) => Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
};

function arg(args: Record<string, string>, key: string, fallback = ""): string {
  return typeof args[key] === "string" && args[key].length > 0 ? args[key] : fallback;
}

const PROMPTS: McpPromptDefinition[] = [
  {
    name: "review_and_sign",
    description:
      "Walk an agent through reviewing an unsigned document and signing if it meets the supplied expectations. Reinforces the pre-sign safety contract.",
    arguments: [
      { name: "request_id", description: "Request id to review.", required: true },
      { name: "token", description: "Per-signer token from request create's tokens[].", required: true },
      { name: "expected_title_pattern", description: "Regex the title must match (optional)." },
      { name: "expected_sha256", description: "SHA-256 the document must match (optional)." },
    ],
    build: (a) => {
      const titleClause = arg(a, "expected_title_pattern")
        ? ` --require-title ${JSON.stringify(arg(a, "expected_title_pattern"))}`
        : "";
      const hashClause = arg(a, "expected_sha256")
        ? ` --require-hash ${arg(a, "expected_sha256")}`
        : "";
      return [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "You are acting as the signer for a Sign CLI request. Follow this protocol exactly:",
              "",
              `1. Inspect the request snapshot via the \`request_show\` tool with { request_id: "${arg(a, "request_id")}" }.`,
              "   Read the title, signer email, and current status. If status is not 'sent', stop.",
              "",
              `2. Fetch the unsigned document via the \`signer_fetch_document\` tool with { request_id: "${arg(a, "request_id")}", token: "${arg(a, "token")}", out_path: "/tmp/signing-review.pdf" }.`,
              "   Re-read the resulting JSON's `sha256` and `title` fields.",
              "",
              "3. Decide: would a reasonable counterparty sign this document?",
              "   If you are unsure, prefer to decline via `signer_decline` with a clear reason.",
              "",
              `4. If you decide to sign, invoke the \`sign\` tool with { request_id: "${arg(a, "request_id")}", token: "${arg(a, "token")}"${titleClause ? `, require_title: ${JSON.stringify(arg(a, "expected_title_pattern"))}` : ""}${hashClause ? `, require_hash: "${arg(a, "expected_sha256")}"` : ""} }.`,
              "   The pre-sign safety checks throw before any state change if your expectations don't match — this is a feature, not a bug.",
              "",
              "5. Confirm completion with `request_show` again. Status should be 'sent' (more signers pending) or 'completed'.",
              "",
              "Reply with a short summary of your decision and what you observed at each step.",
            ].join("\n"),
          },
        },
      ];
    },
  },
  {
    name: "policy_check",
    description:
      "Explain how to encode the agent's signing policy as a JSON file and apply it via `signer policy run`. Useful for repeat counterparties.",
    arguments: [
      { name: "policy_file", description: "Path to write the policy spec.", required: true },
      { name: "request_id", description: "Request id to apply the policy to.", required: true },
      { name: "token", description: "Per-signer token.", required: true },
    ],
    build: (a) => [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Help me codify this signing policy as a JSON file and apply it. The schema:",
            "",
            "```json",
            "{",
            '  "expectations": {                         // non-negotiable; failures throw POLICY_VIOLATION before any rule runs',
            '    "titleMatches": "^…regex…$",',
            '    "documentSha256": "abc...",',
            '    "signerEmail": "alice@example.com"',
            "  },",
            '  "rules": [                                 // first-match-wins',
            '    { "match": { "titlePattern": "addendum" }, "action": "decline", "reason": "needs human review" },',
            '    { "match": { "titlePattern": "^Mutual NDA" }, "action": "sign" },',
            '    { "match": "any", "action": "decline", "reason": "no rule matched" }',
            "  ]",
            "}",
            "```",
            "",
            `1. Write the policy to ${arg(a, "policy_file")}.`,
            "2. Apply it via the `signer_policy_run` tool (or the `sign signer policy run` CLI) with",
            `   { request_id: "${arg(a, "request_id")}", token: "${arg(a, "token")}", spec_path: "${arg(a, "policy_file")}" }.`,
            "3. If you're not sure about the rules, run with --dry-run true first; the audit chain records the decision but no state mutates.",
            "",
            "Reply with the policy you'd write and the decision the engine produced.",
          ].join("\n"),
        },
      },
    ],
  },
  {
    name: "inbox_triage",
    description: "Orient an agent that's just been given access to a signer-side inbox and one or more tokens.",
    arguments: [
      { name: "signer_email", description: "Filter the inbox to one signer.", required: true },
    ],
    build: (a) => [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You're acting as ${arg(a, "signer_email")}. Triage the pending inbox:`,
            "",
            `1. Call the \`signer_list\` tool with { signer_email: "${arg(a, "signer_email")}" }.`,
            "   For each entry, note: requestId, title, signers[], signedBy[], and tokens[] (look for expiresSoon=true).",
            "",
            "2. Order entries by urgency: tokens with `expiresSoon=true` first, then by createdAt.",
            "",
            "3. For each entry, decide: skip, fetch + review, sign, decline. Use:",
            "   - `signer_fetch_document` to inspect content (records request.signer_fetched_document in the audit chain).",
            "   - `sign` to commit (with `require_*` arguments matching what the requester told you).",
            "   - `signer_decline` if you can't approve.",
            "",
            "4. If a token is expiring soon and you can't decide in time, recommend `signer reissue-token` to the requester.",
            "",
            "Reply with a per-request decision plus a short rationale.",
          ].join("\n"),
        },
      },
    ],
  },
  {
    name: "verify_receipt",
    description: "Walk a recipient through verifying a `request receipt` bundle they received.",
    arguments: [
      { name: "bundle_dir", description: "Path to the receipt directory.", required: true },
    ],
    build: (a) => [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You received a Sign CLI receipt bundle at ${arg(a, "bundle_dir")}. Verify it.`,
            "",
            `1. Run \`sign request verify-receipt --bundle ${arg(a, "bundle_dir")}\`. The output is JSON with \`ok\`, \`manifestVerified\`, \`files[]\`, \`chain\`, and \`errors[]\`.`,
            "",
            "2. Confirm:",
            "   - manifestVerified=true (the embedded cert + manifest.sig is genuine).",
            "   - every files[].ok=true (no file in the bundle was tampered with after signing).",
            "   - chain.ok=true (the audit chain is locally hash-linked correctly).",
            "",
            "3. Inspect signerSubject: it should match the entity you expect issued the receipt. (For local-provider receipts, this is `Sign CLI Local Signer` or a per-signer cert.)",
            "",
            `4. (Defence in depth) Verify the openssl path independently: \`openssl dgst -sha256 -verify <(openssl x509 -pubkey -noout -in ${arg(a, "bundle_dir")}/manifest.cert.pem) -signature ${arg(a, "bundle_dir")}/manifest.sig ${arg(a, "bundle_dir")}/manifest.json\`.`,
            "",
            "Reply with a verdict (verified / failed / partially-verified) plus the specific evidence you used.",
          ].join("\n"),
        },
      },
    ],
  },
];

export function listMcpPrompts(): Array<Pick<McpPromptDefinition, "name" | "description" | "arguments">> {
  return PROMPTS.map(({ name, description, arguments: args }) => ({
    name,
    description,
    ...(args ? { arguments: args } : {}),
  }));
}

export function getMcpPrompt(input: { name: string; arguments?: Record<string, string> }): {
  description: string;
  messages: Array<{ role: "user" | "assistant"; content: { type: "text"; text: string } }>;
} {
  const prompt = PROMPTS.find((entry) => entry.name === input.name);
  if (!prompt) {
    throw new SignCliError({
      code: "UNKNOWN_RESOURCE",
      message: `Unknown MCP prompt: ${input.name}`,
      hint: "Use `prompts/list` to see the catalog.",
    });
  }
  const args = input.arguments ?? {};
  for (const declared of prompt.arguments ?? []) {
    if (declared.required && !(declared.name in args)) {
      throw new SignCliError({
        code: "INVALID_ARGS",
        message: `Prompt "${prompt.name}" requires argument: ${declared.name}`,
        details: { prompt: prompt.name, missing: declared.name },
      });
    }
  }
  return {
    description: prompt.description,
    messages: prompt.build(args),
  };
}
