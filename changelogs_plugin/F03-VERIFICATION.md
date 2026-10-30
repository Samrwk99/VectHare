# F03 Verification — 28 October 2026

## Baseline and delivered packages
- Extension: `2.2.0-alpha.s11.8-f03`; plugin: `3.2.10-s10.7-f03`.
- Verified plugin executable manifest source fingerprint: `6db71540d66f656eee6b6e6d44d8197af51f2a76b7c13f045f682656ae110e95`.
- All executable plugin files pass `node --check`. All extension JS/MJS files pass `node --check`.
- **Plugin suite:** 279 / 279 assertions/tests passed in a Node VM-module runner.
- **Extension:** 61 / 61 test files, 1,103 passing assertions, 0 failed files, 0 retries, isolated Node VM-module runs.
- **New F03 plugin tests:** vector normalization/float32, tampering, explicit consent, client-scope denial, durable receipts, one-time retry refusal, uncertain backend response, local multi-instance and cross-process lock exclusivity, Qdrant fake-HTTP index verification, uncertain index outcomes, status recovery.
- **New F03 extension tests:** request gateway allowlist and negative cases, same-origin requests, overclaim refusal, GUI control rendering.
- Fresh ZIP extraction verification: see delivery manifest and package-verification output.

## Scope and confidence

The Qdrant HTTP acceptance is a **simulated local transport**, not a connection to the user's running Termux Qdrant. Milvus lifecycle is covered by previous S07 fixture tests and new route authorization tests, not real Milvus acceptance. Lock contention between separate Node processes sharing a filesystem was exercised on Linux. Windows/Termux behavior and OS crash resilience have not been tested.

The F03 `SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED` receipt name is intentional. It means that the server checked a schema response; it is **not** a remote attestation or certification of the entire installation.

All public production v2 insert/update/delete routes and existing legacy mutations remain denied. The new schema provisioning endpoint is a separate explicitly confirmed action, not a generic vector-write grant. Native Standard/LanceDB/Vectra provisioning is not activated.

## Critical open risks

1. Qdrant/Milvus lack independently proven external-writer revision CAS; local file serialization is insufficient for uncoordinated database writers.
2. There is no real SillyTavern/Termux backend acceptance yet. F03 must be host-tested before activation decisions.
3. An uncertain receipt can require manual recovery. No automatic cleanup, force-unlock or destructive rollback is enabled.
4. Full inventory, verified exports, migration and legacy hash-point edits remain disabled.
