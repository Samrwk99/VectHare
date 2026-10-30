# F05 — Qdrant extended host-acceptance candidate

**Baseline:** VectHare S11.9-F04 + Similharity S10.8-F04.
**Delivered:** VectHare S11.10-F05 + Similharity S10.9-F05.
**Decision:** Partial F05 implementation; NOT Qdrant production activation.

## Implemented

1. Added `lib/f05-qdrant-acceptance.js`: an authenticated, deliberately consented server route `POST /v2/diagnostics/qdrant-f05` for **local** Qdrant only. The server picks a fresh cryptographic run ID and newly derived v2 collection, source scope, synthetic embedding, record ID and operation IDs. No browser input chooses a physical collection, user or vector record.
2. Extended real-backend acceptance checks: fresh collection provisioning; schema and seven owner-index verifications; insert; physical vector/content readback; scoped similarity query; metadata edit with revision bump; stale-revision rejection; read pagination; new adapter/client reopen; exact targeted deletion and absence readback.
3. Reused the existing S04 durable ledger, mutation engine and S06 Qdrant adapter inside the restricted synthetic acceptance. Backend mutation failure returns an uncertain result and never automatically retries, drops a collection or purges legacy data.
4. Added explicit GUI button and understandable stage-by-stage results through `utils/f05-acceptance-client.js`.
5. Added the `x-vecthare-f05-diagnostic` request header and origin-site guard. The extension request gateway permits only the exact fixed route/selector/consent shape.
6. Extended plugin capability discovery with a separate **diagnostic-only** F05 route claim and updated the extension's exact plugin fingerprint.
7. Added tests for unauthorized API shape, cross-route bypass, mutation failure, successful completion, false production claims and the **real Qdrant HTTP client against a disposable local Qdrant-shaped HTTP fixture**.

## What has NOT been implemented

This checkpoint does not connect the ordinary VectHare chat memory pipeline to v2; does not migrate legacy vectors; does not activate public general memory write/delete/revectorization/export; does not prove the live Termux server; and does not supply Qdrant native atomic conditional revision writes against independent clients. A passing disposable acceptance is necessary evidence, **not sufficient** for safe everyday write activation.
