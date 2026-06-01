# DocuSign setup

JWT-based auth with user impersonation + an RSA private key file.

## Operator checklist

1. Create a DocuSign app (Integration Key) in the correct account/environment.
2. Enable JWT Grant and configure user impersonation.
3. Generate/download the RSA private key and store it locally — **never commit it**.
4. Grant consent for the impersonated user against the integration key.
5. Set env vars (below), then run `sign doctor` and confirm DocuSign fields are present.
6. Run a smoke flow in demo/sandbox: `request create` → `approve` → `request send --provider docusign` → `request watch --provider docusign`.

## Daily usage

1. Set `SIGN_PROVIDER=docusign` to make DocuSign the default for every command (otherwise the built-in default is the offline `local` provider).
2. For per-request control, add `--provider docusign` only on DocuSign flows.
3. Create + approve the request, then send.
4. Use `request watch` for completion and optional auto-download.

## Required env vars

```env
SIGN_PROVIDER=docusign
DOCUSIGN_INTEGRATION_KEY=your_integration_key
DOCUSIGN_USER_ID=your_impersonated_user_guid
DOCUSIGN_ACCOUNT_ID=your_account_id
DOCUSIGN_BASE_PATH=https://demo.docusign.net/restapi
DOCUSIGN_PRIVATE_KEY_PATH=./keys/docusign-private.key
```

## JWT prerequisites

- Create a DocuSign integration key.
- Configure JWT auth for that integration key.
- Grant consent for the impersonated user.
- Store the RSA private key locally and point `DOCUSIGN_PRIVATE_KEY_PATH` at it.

## Send, watch, and download

```bash
sign request create \
  --title "DocuSign Consent Test" \
  --document ./your.pdf \
  --signer name:Alice,email:alice@example.com,order:1 \
  --provider docusign

sign approve --request-id <request_id> --token <token>

sign request send \
  --request-id <request_id> \
  --provider docusign

sign request watch \
  --request-id <request_id> \
  --provider docusign \
  --interval-seconds 5 \
  --fetch-final true \
  --out ./artifacts/<request_id>-signed.pdf
```

DocuSign terminal states are normalized into the same `request watch` exit codes as every provider: `completed` exits `0`, `declined/rejected/expired/voided` exits `2`, provider errors exit `3`, timeouts exit `4`.

## Embedded signing

DocuSign embedded uses recipient view with `clientUserId`. `request send-embedded --provider docusign` sets `clientUserId` at send time; `request sign-url` / `request launch-embedded` require `--return-url` (DocuSign bounces the user there after signing). See [embedded.md](embedded.md) for the full flow.
