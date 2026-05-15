# Embedded Signing Setup (Dropbox Side) — Step by Step

This guide is for first-time setup before running `request send-embedded`.

## 1) Create an API App in Dropbox Sign
1. Go to Dropbox Sign account settings → API.
2. Create an API App.
3. Copy the **Client ID**.
4. Keep your **API key** private (server-side only).

## 2) Register an allowed domain (no localhost)
Dropbox Sign embedded signing does not accept `localhost` as app domain.

Use a public tunnel/domain, for example:
- `https://good-ravens-drum.loca.lt`

Add that domain in the API App domain settings.

## 3) Set Callback URL (recommended)
Set callback URL to something like:
- `https://good-ravens-drum.loca.lt/dropbox/callback`

Notes:
- Use HTTPS.
- This URL should be reachable from Dropbox Sign.
- You can validate signatures with HMAC in your webhook handler.

## 4) Local env configuration
```env
DROPBOX_SIGN_API_KEY=...
DROPBOX_SIGN_CLIENT_ID=...
DROPBOX_SIGN_TEST_MODE=true
SIGN_DB_PATH=./data/sign.db
```

## 5) Run embedded flow
1. Create + approve request in CLI.
2. Send embedded request:
```bash
npm run start -- request send-embedded --request-id <request_id> --client-id <client_id> --test-mode true
```
3. Generate sign URL(s):
```bash
npm run start -- request sign-url --request-id <request_id> --signature-id <signature_id>
```
4. Open via HelloSign Embedded JS using your `clientId`.

## 6) Common errors
- `Missing parameter: client_id`
  - You opened sign URL directly, not via embedded JS + `clientId`.
- `localhost is not a valid domain name`
  - Register a public domain/tunnel in API App settings.

## 7) Production checklist
- Turn off `test_mode`.
- Use real domain + TLS.
- Rotate API keys.
- Persist webhook events in audit log.
