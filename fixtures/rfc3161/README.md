# RFC 3161 test fixtures

Real, self-issued RFC 3161 timestamp material used by
`src/tests/timestamp-verify.test.ts` to exercise the CMS verification in
`src/lib/timestamp-verify.ts`. Everything here is a throwaway test CA — no
production trust is implied.

| File | What it is |
| --- | --- |
| `stamped-data.bin` | The bytes that were timestamped. |
| `stamped-data.sha256` | `sha256(stamped-data.bin)` — the messageImprint the token must cover. |
| `valid-token.tsr` | A valid `TimeStampResp` (DER) over that digest, signed by `tsa-signer.crt`. |
| `tsa-signer.crt` | The TSA leaf certificate (carries `extendedKeyUsage = timeStamping`). |
| `test-ca.crt` | The root CA that issued the TSA cert (use as a trust anchor). |

## Regenerating

```sh
# Root CA
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out test-ca.crt -days 3650 \
  -nodes -subj "/CN=Sign CLI Test TSA Root/O=Sign CLI Test"

# TSA leaf with the required timeStamping EKU
openssl req -newkey rsa:2048 -keyout tsa.key -out tsa.csr -nodes \
  -subj "/CN=Sign CLI Test TSA/O=Sign CLI Test"
printf '[v]\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\nbasicConstraints=critical,CA:FALSE\n' > ext.cnf
openssl x509 -req -in tsa.csr -CA test-ca.crt -CAkey ca.key -CAcreateserial \
  -out tsa-signer.crt -days 3650 -extfile ext.cnf -extensions v

# Issue a token over the data
printf 'sign-cli-audit-chain-head-digest' > stamped-data.bin
openssl ts -query -data stamped-data.bin -sha256 -cert -out q.tsq
# ...with a tsa.cnf pointing signer_cert=tsa-signer.crt, certs=test-ca.crt, signer_key=tsa.key
openssl ts -reply -config tsa.cnf -section tsa_config -queryfile q.tsq -out valid-token.tsr
```

Note: `openssl ts -reply` refuses to sign with a certificate that lacks the
`timeStamping` EKU, which is itself a good sign the requirement is real.
