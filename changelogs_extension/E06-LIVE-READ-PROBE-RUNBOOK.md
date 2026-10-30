# E06 read-only probe (disposable local installation only)

This diagnostic is optional and **does not certify a backend**. It only calls Similharity `GET /health` and `POST /chunks/list`, never insert, delete, purge, or patch. It does not print or store record text or vectors. It still accesses the configured tenant's metadata; only use throwaway/test data.

From the extension directory after installing Similharity in an isolated test SillyTavern:

```bash
VECTHARE_PROBE_DISPOSABLE=1 VECTHARE_PROBE_ORIGIN=http://127.0.0.1:8000/ \
  node tools/e06-read-probe.mjs qdrant vh:chat:test123
VECTHARE_PROBE_DISPOSABLE=1 VECTHARE_PROBE_ORIGIN=http://127.0.0.1:8000/ \
  node tools/e06-read-probe.mjs milvus vh:chat:test123
```

The script accepts only loopback HTTP origins with no URL credentials or path. It does not send credentials, CSRF tokens or browser cookies. Standard authenticated SillyTavern deployments may reject it; do not weaken your server authentication to make the probe pass. Use manual in-browser verification if necessary, recording redacted evidence only.

A result of `UNVERIFIED_READ_ONLY` means a displayed read response had a valid envelope and explicit owner fields; it never means the backend was correctly filtered, fully enumerated, healthy or safe for writes. A result of `ERROR_OR_UNVERIFIED` includes no untrusted record contents. Re-run after a server restart for stability evidence. Save sanitized results for E07 acceptance.
