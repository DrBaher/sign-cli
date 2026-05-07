# Provider selection guide

The CLI supports three providers. Use this guide to decide which to wire up first.

| Capability                  | Dropbox Sign | DocuSign       | SignWell |
|-----------------------------|:------------:|:--------------:|:--------:|
| Email send (`request send`) | yes          | yes            | yes      |
| Embedded signing            | yes (JS SDK) | not in CLI     | yes (iframe) |
| Webhook ingest              | yes          | not in CLI     | yes      |
| Final PDF download          | yes          | yes            | yes      |
| Test mode                   | yes          | sandbox host   | yes      |
| Account check               | yes          | yes (JWT)      | yes      |

Run the live matrix any time:
```bash
node dist/cli.js doctor providers
```
The output reflects which env vars are set on the current shell.

## Decision shortcuts
- "I just want a simple API key + send + watch flow" → Dropbox Sign or SignWell.
- "We are already a DocuSign customer" → DocuSign with JWT.
- "We need embedded signing inside our app and don't want to integrate the HelloSign JS SDK" →
  SignWell (renders via iframe).
- "We want webhook callbacks today" → Dropbox Sign or SignWell.

## Switching default provider
Set `SIGN_PROVIDER=dropbox|docusign|signwell` in `.env`, or pass `--provider <name>` to any command.
The flag takes precedence over the env var.
