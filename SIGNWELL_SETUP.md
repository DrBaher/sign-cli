# SignWell setup

## Agent onboarding
1. Create or log into the SignWell account that will own API-created documents.
2. Generate an API key from `Settings -> API`.
3. Store the API key in `.env` as `SIGNWELL_API_KEY`. Never commit it.
4. If you need a non-default API host, set `SIGNWELL_BASE_URL`. Otherwise leave it unset and the CLI uses `https://www.signwell.com/api/v1`.
5. Keep `SIGNWELL_TEST_MODE=true` while validating the flow.
6. Run `npm run start -- doctor` and confirm `hasSignWellApiKey` is `true`.
7. Run `npm run start -- doctor account-check --provider signwell` and confirm the `/me` check succeeds.

## User onboarding
1. Set `SIGN_PROVIDER=signwell` if SignWell should be the default provider.
2. Or keep another default provider and add `--provider signwell` only on SignWell flows.
3. Create a request, approve it, send it, then use `request watch` to wait for completion.
4. Use `request fetch-final` after completion, or add `--fetch-final true` to `request watch`.

## Required env vars
```env
SIGN_PROVIDER=signwell
SIGNWELL_API_KEY=your_signwell_api_key
SIGNWELL_BASE_URL=https://www.signwell.com/api/v1
SIGNWELL_TEST_MODE=true
```

## Example flow
```bash
npm run start -- request create \
  --title "SignWell Consent Test" \
  --document ./your.pdf \
  --signer name:Alice,email:alice@example.com,order:1 \
  --signer name:Bob,email:bob@example.com,order:2 \
  --provider signwell

npm run start -- approve --request-id <request_id> --token <token1>
npm run start -- approve --request-id <request_id> --token <token2>

npm run start -- request send \
  --request-id <request_id> \
  --provider signwell \
  --test-mode true

npm run start -- request watch \
  --request-id <request_id> \
  --provider signwell \
  --interval-seconds 5 \
  --fetch-final true \
  --out ./artifacts/<request_id>-signed.pdf
```

## Implementation notes
- The CLI sends SignWell documents through `POST /documents` with `with_signature_page=true`, so field placement is not required for this MVP.
- Signer ordering is carried into SignWell via `apply_signing_order=true` whenever there is more than one signer.
- The persisted `signatureIds` field contains SignWell recipient IDs.
- Embedded signing is not wired for SignWell in this CLI. Use the standard send/status/watch/fetch-final flow.

## Troubleshooting
- `SIGNWELL_API_KEY is not set.`
  - Add `SIGNWELL_API_KEY` to `.env` or export it in the shell before running the CLI.
- `SignWell request failed: ...`
  - Check the API key, API plan access, and whether the uploaded file type is supported by SignWell.
- `SignWell PDF download failed: ...`
  - The document is usually not fully completed yet, or SignWell is still generating the final PDF. Retry after `request watch` reports `completed`.
- `Embedded signing is not yet supported for SignWell.`
  - This CLI currently supports SignWell for email/request lifecycle flows only.
