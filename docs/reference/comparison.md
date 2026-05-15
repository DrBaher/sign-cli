# How is this different?

A frank comparison so you can decide quickly whether `sign-cli` fits.
We're better at some things, worse at others — the table below isn't a
sales pitch. If something here is wrong, please open an issue.

## At a glance

| | sign-cli | Dropbox Sign / DocuSign / SignWell SaaS | DIY (raw provider SDK) | OpenSign / open-source SaaS |
|---|---|---|---|---|
| **Account / signup needed to try** | No (`npx @drbaher/sign-cli demo`) | Yes (free trial) | Yes (provider key) | Self-host required |
| **Native UI for signers** | No (use the provider's, or build your own on `/v1/*`) | Yes — full web app | No | Yes |
| **Programmatic policy** | Declarative spec (`signer policy run-watch`) | Workflow rules in their UI | Roll your own | Workflow rules in their UI |
| **MCP server for LLM agents** | Yes (stdio + typed tool catalog) | No | No | No |
| **Cross-provider fungibility** | One CLI over Dropbox/DocuSign/SignWell + local | Tied to one vendor | Tied to one vendor | Tied to one vendor |
| **Append-only audit chain** | Yes (`audit_events`, hash-linked, SQL triggers) | Vendor-controlled | Roll your own | Varies |
| **RFC 3161 timestamping** | Yes (`audit timestamp`, `audit anchor`) | Some plans | Roll your own | Rare |
| **Re-verifiable receipt bundle** | Yes (`request receipt` + `chain-bundle`) | Vendor-issued certificate | Roll your own | Varies |
| **No-account local provider** | Yes (PAdES-signed PDF, fully offline) | No | No | No |
| **Postgres-ready** | Async surface + bootstrap + smoke command | N/A (vendor-hosted) | Whatever you build | Yes |
| **Hosted SaaS** | No | Yes | No | Some have hosted offerings |
| **Single-binary install** | Yes (Node SEA) | N/A | N/A | Containers/k8s |

## Where we're stronger

- **Agent integration**: typed `tools/list`, `--capability` / `--tool` allow-listing, `--read-only`, `--emit-events` replay log. No other CLI ships an MCP server.
- **Auditor handoff**: `chain-bundle` is self-contained — auditors verify offline against just the bundle, no DB access required. Most providers issue a one-shot certificate; ours is a re-runnable verification.
- **Operational composability**: every command is JSON in / JSON out, every flag is in the `--catalog` machine-readable index, every long-running process honors `--report` NDJSON streaming.

## Where we're weaker

- **No native signer UI**. Signers either use the provider's web app or click a link in an email you generate. The bundled `--web-demo` is operator-facing, not signer-facing.
- **No SaaS**. You self-host. There's a `--web-demo true` knob but no managed offering.
- **Onboarding is CLI-shaped**. Easy if you live in a terminal; rough if you don't. We have `sign init` to scaffold a `.env` and `doctor providers` to confirm wiring, but a Dropbox Sign user used to "click here to invite" will feel friction.
- **Provider feature parity**. We expose the verbs that fit the lifecycle: create, send, sign, decline, status, fetch-final. Provider-specific niceties (templates with prefilled fields, branded emails, custom redirects) require dropping to the provider SDK.

## When we're a good fit

- You're building **agent-first workflows** — Claude / langchain / your own — and want a typed tool catalog with capability scoping.
- You need **independent audit verifiability**: hash chains, RFC 3161 anchors, self-contained receipts that verify offline a year later.
- You want **provider portability**: prototype on the local provider, ship on Dropbox Sign, swap to DocuSign, without rewriting business logic.
- You're an **ops person** who'd rather grep, jq, and pipe than click.

## When we're not

- Your signers expect a fully branded web UI.
- You don't have anyone willing to operate a CLI / containerized service.
- You need provider-specific features (branded templates, advanced workflow routing) more than cross-provider portability.
- You need a SaaS today and don't want to self-host.
