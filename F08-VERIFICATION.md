# F08 — Verification report

## Offline results
- **Similharity plugin: 312/312** Node tests passed (`node --experimental-vm-modules --test tests/*.test.mjs`). Includes F08 source-bound lifecycle, server-issued collection identity, consent/shape rejection, remote connection denial, float32 input checks, replay refusal, stale revision, readback and uncertain-write no-retry behavior, plus all prior checkpoints.
- **VectHare extension: 1,130 assertions in 66 test files** passed in isolated Node VM runs (no crash retries in that run), with 28 additional focused F08/compatibility assertions passing after fingerprint updates.
- All JS/MJS files passed `node --check`. The build includes the S10 source fingerprint and matched extension pin. Fresh-extraction verification is recorded separately in the delivered hashes report.

## Verified offline, NOT live-certified
- F03/S07 Milvus v2 schema definition and read/write adapter are exercised using a **simulated SDK transport**, not a real Milvus database.
- F08 disposable acceptance exercises provision, schema, insert, readback, query, metadata update, stale revision refusal, pagination, adapter reopen, deletion and empty readback. No existing collection is targeted and no collection is dropped automatically.
- F08 manual pilot exercises source-bound CRUD through S04 with durable receipts, exact collection binding, local-only backend restriction, owner/ID request rejection, revision safety and replay refusal.
- Production writes, native Standard mutations, unrestricted inventory/export, legacy collections and automatic chat/summary/World Info memory workflows remain disabled.

## Still unproven
- Real Milvus 2.x client compatibility, actual Milvus server behavior and startup/index consistency; external-writer atomic revision compare-and-swap and recovery after process/server crashes.
- Host user/branch isolation in a running SillyTavern installation, across concurrent sessions and restarts.
- Live Termux, Linux, Windows deployments (Milvus itself may not be available locally on each platform).
- Other backend acceptance from F05–F07, native Standard host mutation contract, F09–F12 workflows/export/GUI finishing.

**Decision: F08 GUARDED DEVELOPMENT CANDIDATE. NOT PRODUCTION READY.**
