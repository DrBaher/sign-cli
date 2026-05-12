# Recipes

Step-by-step guides for the most common end-to-end flows. Each recipe assumes
you have `sign` on your `$PATH` (built locally via `npm run build`) and that
you've run `sign init` to scaffold the local provider.

| Recipe | When you'd reach for it |
|---|---|
| [Sign as Alice (local provider)](signer-flow-local.md) | First-time walkthrough: create a request, send it, sign it, verify it, hand off the receipt. |
| [Weekly audit anchor](weekly-anchor.md) | Periodic continuity proof — anchor every chain head, store the .tsr, re-verify next week. |
| [Auditor handoff bundle](auditor-handoff.md) | Compliance review: package the anchor + per-request receipts into a single self-contained bundle. |
| [Agent loop over MCP](agent-loop-mcp.md) | Drive the CLI from an LLM agent: tools/list, tools/call, capability scoping, replay logs. |
| [Mutual EU NDA from template](eu-nda.md) | End-to-end B2B NDA flow using the bundled markdown template with the method-consent clause baked in (see [`legal-posture.md`](../legal-posture.md) for why that matters). |

## Quick links to reference docs

- `sign --help` for the full command catalog (also: `sign help <command>`)
- [`MIGRATION.md`](../../MIGRATION.md) for the storage backend / async-migration roadmap
- [`fixtures/web-demo/`](../../fixtures/web-demo) for a 1-file dashboard you can serve via `sign serve --web-demo true`
