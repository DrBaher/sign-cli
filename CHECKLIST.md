# Setup checklist

Same checklist for any provider. Replace `<provider>` with `dropbox`, `docusign`, or `signwell`.

- [ ] Node 22+ installed.
- [ ] `npm install` and `npm run build` succeed.
- [ ] `.env` filled in for the chosen provider — either by hand from `.env.example`, or via `node dist/cli.js init`.
- [ ] `node dist/cli.js doctor` shows the env flags as `true`.
- [ ] `node dist/cli.js doctor providers` shows the chosen provider as `configured: true` with no `missing` entries.
- [ ] `node dist/cli.js doctor account-check --provider <provider>` succeeds.
- [ ] One test-mode/sandbox `request create` + `approve` + `request send --provider <provider>` succeeds.
- [ ] `node dist/cli.js request watch --request-id <id> --provider <provider> --interval-seconds 5 --fetch-final true` exits 0.
- [ ] Signed PDF lands in `./artifacts/`.
- [ ] (Dropbox / SignWell only) `webhook listen --provider <provider>` returns 200 for a verified test event.
- [ ] (SignWell only, optional) `scripts/smoke-signwell.sh` runs end-to-end.
