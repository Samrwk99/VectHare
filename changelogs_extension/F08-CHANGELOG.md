# F08 — Milvus v2 integration changelog

Baseline: F07 matched release. Delivered component versions: **VectHare 2.2.0-alpha.s11.13-f08** and **Similharity 3.2.10-s10.12-f08**.

## Plugin
- Retains F03 authenticated, new-only Milvus v2 collection provisioning with strict physical schema, primary key, vector dimension and index-metric inspections. F02 source-bound `get`, paginated `list` and `query` routes remain guarded.
- Adds `lib/f08-milvus-acceptance.js`: `POST /v2/diagnostics/milvus-f08`, accepting only `{configId:"default",consent:"I ACCEPT F08 DISPOSABLE MILVUS TEST"}` and same-origin diagnostic header. Generates server-side disposable collection/record IDs; executes 11 synthetic lifecycle stages with real Milvus SDK client calls when available. No automatic drop, purge or retry.
- Adds `lib/f08-milvus.js`: `POST /v2/records/milvus-pilot-mutate`, a source-attested and F03-receipt-verified manual pilot for NEW v2 collections using S04 durable ledger, revision preflight and vector readback. A loopback connection is mandatory for the manual pilot, and each mutation requires explicit consent and unique record/operation UUIDs.
- Allows S07 v2 mutation adapter execution only with its existing internal disposable flag or the new trusted internal F08 source-bound pilot flag. Ordinary public mutation and legacy routes remain denied.
- Rejects owner/collection/path/physical-ID injection, unrelated request fields, remote pilot connection, invalid revision, malformed metadata and non-float32-exact vectors before mutation dispatch. Uncertain operations retain read-only receipts and must not be retried blindly.
- Updates capability/contract discovery without claiming production-certified Milvus writes or verified exports; adds adapter/route regressions.

## Extension
- Adds F08 disposable Milvus acceptance GUI and source-bound manual Milvus pilot GUI with read-only S04 operation-receipt lookup.
- Converts user-supplied manual pilot vectors to float32 to meet Milvus FloatVector requirements; refuses requests that do not match the exact guarded F08 request shape.
- Adds explicit F08 request gateway allowlist, updates plugin fingerprint/version expectations and preserves all E02 legacy mutation restrictions.
- Does NOT convert normal chat, summary, World Info or automatic memory workflows to Milvus v2 production writes. These require F09 and real host acceptance.
