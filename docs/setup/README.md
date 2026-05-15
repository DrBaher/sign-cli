# Setup

Provider-specific configuration. You only need to read the one(s) you'll use.

| File | Use when |
|---|---|
| [providers.md](providers.md) | Picking between Dropbox Sign, DocuSign, SignWell, or the offline local provider. |
| [dropbox.md](dropbox.md) | Setting up Dropbox Sign (10-minute onboarding for a new account). |
| [docusign.md](docusign.md) | Setting up DocuSign with JWT-based auth + RSA key files. |
| [signwell.md](signwell.md) | Setting up SignWell with API-key auth. |
| [embedded.md](embedded.md) | Wiring up embedded (browser-based) signing for any of the three hosted providers. |

For an offline / no-signup setup, run `sign demo` — the local PAdES signer needs nothing more.
