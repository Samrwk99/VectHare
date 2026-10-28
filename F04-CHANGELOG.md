# F04 — Authorized v2 record-mutation integration (restricted Qdrant pilot)

**Date:** 28 October 2026  
**Basis:** the F03 matched VectHare extension + Similharity plugin source.  
**Extension:** `2.2.0-alpha.s11.9-f04`; **plugin:** `3.2.10-s10.8-f04`.

## Delivered

- Added a new plugin route `POST /v2/records/pilot-mutate`, wired to the **actual** S04 `MutationEngine`, durable `OperationLedger`, F02 verified binding, F01 saved-file attestation, F03 provisioning receipt, live collection-schema inspection, seven Qdrant ownership index checks, and S06 Qdrant v2 record adapter.
- Supports individual **insert, full update, metadata-only update, and targeted delete** with expected revision, record UUID and operation UUID, requiring explicit consent. The route is **local-loopback Qdrant pilot only**, and only on a newly F03-provisioned `vh2_...` collection. It is not a production/automatic memory-write grant.
- Physical collection and user/source/branch scopes are **server-derived**, never read from browser-supplied scope or point IDs. Browser connection credentials and arbitrary endpoint URLs cannot be sent through the route.
- Every mutation re-attests the saved source, verifies the F03 receipt and physical schema, checks the exact collection binding, and runs the S04 preflight / SUBMITTED / VERIFIED / UNCERTAIN ledger lifecycle. Cross-process same-user-root collection/record serialization remains in force.
- Expanded metadata-only preservation verification: text and original physical vector must remain unchanged, not merely the new metadata hash. Crash-time verification lacking the original vector proof remains UNCERTAIN.
- Standardized replay refusal with `S04_OPERATION_EXISTS` rather than leaking raw filesystem `EEXIST`.
- Added pilot-specific origin and `x-vecthare-f04-pilot: 1` header enforcement in addition to SillyTavern's host authentication and ordinary request protections.
- Added a clearly marked F04 **manual pilot** panel in the VectHare GUI for a saved source, with local Qdrant selection, embedding identity, insert/update/metadata/delete inputs, explicit confirmation, stable record/operation UUIDs, readback state and read-only S04 receipt inspection.
- Extended the VectHare E02 gateway with tightly scoped approval for **only** the reviewed F04 pilot route and read-only operation receipts. The existing legacy `/chunks/*` and general `/v2/records/{insert,update,delete}` routes remain blocked.
- Updated S10 plugin capabilities/contracts and VectHare's exact plugin source fingerprint pin. No client-visible capability report claims production writes are active.

## Explicitly NOT delivered / NOT activated

- General VectHare manual/automatic memory insertion, editing, revectorization, summary jobs, and legacy hash-based writes remain **DENIED**.
- Qdrant cloud/shared or multi-writer writes remain denied. There is **no proven native Qdrant atomic revision CAS**; local same-user filesystem locks do not stop external database writers or multiple independently rooted SillyTavern processes.
- Milvus, LanceDB, Similharity Vectra and SillyTavern-native Standard record mutation activation are not included in this checkpoint.
- Legacy data migration, production collection purge, verified inventory/export, crash-time reconciliation of missing original vectors, and automatic retry remain denied.
- No real Termux Qdrant, Windows, Linux-host SillyTavern, Milvus, LanceDB or Vectra acceptance has been performed by this build process.

## Release classification

**DEVELOPMENT / DISPOSABLE BACKEND PILOT ONLY. NOT A PRODUCTION RELEASE.**

The F04 milestone's *public mutation architecture* is now wired for a narrow Qdrant pilot, but full F04 production activation and F05–F12 acceptance remain open. See `F04-RELEASE-DECISION.md` and `F05-NEXT-STEPS.md`.
