# Reference

Concept-level reference for `sign-cli`. Each file is the canonical home for one topic — everything else in the repo links here.

| File | Topic |
|---|---|
| [architecture.md](architecture.md) | The system boxes, data flow, provider abstraction, audit-chain design. |
| [audit-chain.md](audit-chain.md) | What the hash-chained audit log proves, how `audit verify` works, RFC 3161 anchors, and append-only DB triggers. |
| [exit-codes.md](exit-codes.md) | The exit-code map every command honors, plus the structured-error envelope. |
| [profiles.md](profiles.md) | Named profiles bundle (provider, dbPath, credentials). Resolution order, env-var interpolation, project-level discovery. |
| [security-model.md](security-model.md) | Threat model — what the audit chain and PAdES envelope guarantee, what they don't. |
| [security-controls.md](security-controls.md) | Path-traversal guards, secret redaction, read-only MCP/HTTP modes. |
| [legal.md](legal.md) | When a `sign-cli` signature is enforceable. US ESIGN/UETA, EU eIDAS, NDA deep-dive. |
| [comparison.md](comparison.md) | Frank pros/cons vs. SaaS providers and DIY. |
