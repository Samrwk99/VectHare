# F09c.1 verification — 2026-10-29

## Implemented in the matched source
- `MutationEngine` is now **atomic-only by default**. An unqualified new caller does not dispatch ordinary check-then-write mutations.
- The atomic-only mode requires `atomicCompareAndMutate(plan,payload)` and host-trusted authorization fields `atomicBackendCertified:true` and `externalWriterScopeAttested:true`. Missing method or attestation rejects before a ledger intent is written. These booleans are contractual assertions by a trusted host, **not proof** of actual atomicity.
- The conditional compare and physical mutation must occur in **one backend-enforced atomic operation** across nonparticipating external writers. No included real-backend adapter implements that contract yet.
- Only current F09b guarded development pilots and historical acceptance helpers explicitly specify `atomicOnly:false`, preserving their existing restricted behavior. This is not a production-safe option and must never be used as production certification.
- Atomic-only mode never falls back to separate get/update/delete on conflict or exception. After uncertain dispatch, no automatic retry or later readback promotion to VERIFIED is allowed.
- Plugin version `3.2.10-s10.26-f09c1`; extension version `2.2.0-alpha.s11.27-f09c1`; source fingerprint `c976f48a5861e0de89c1a01db61a8d887fc14b7cca20c659fe51902ee52a8c4c`. A matched self-reported source identity is not host attestation.

## Executed tests
- **Plugin:** 400/400 clean in one combined Node test run (`--test-concurrency=2`).
- **Acceptance:** 11/11 across seven new atomic-gate tests, the original one lost-update negative-control test and three evidence-assessor tests. Mock CAS is simulation, not a real provider test.
- **Extension:** combined serial run 1,154 assertions passed, with one `i05-metadata.node.test.mjs` worker ending in SIGSEGV. That same file passed 15/15 separately. Thus all previously expected 1,169 assertions are covered across runs, **but the combined run was not clean**.
- Modified plugin JavaScript syntax checks: 18 files passed. Updated extension S11 compatibility syntax passed.
- Passive host preflight: localhost Qdrant port 6333 unreachable; Milvus 19530 unreachable. No real SillyTavern host, embedded LanceDB or Vectra was live certified.

## Not proved
- No real backend implements the atomic-only mutation adapter yet: Qdrant / LanceDB / plugin Vectra / Milvus CAS remains **BLOCKED**. Legacy v2 pilot writes still use explicitly non-atomic adapters and remain development-only.
- Real Qdrant/Milvus/LanceDB/Vectra CRUD, cross-process external writers, process interruption, crash recovery, Termux/Windows acceptance, independent host attestations and production readiness are all outstanding.
- Full feature parity from F09b (provider coverage, automatic summaries/World Info, links and conditions) remains outstanding.

**Verdict: F09c PARTIAL — guarded production-candidate interface implemented, real-backend acceptance NOT COMPLETE, production NO GO.**
