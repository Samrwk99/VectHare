# M3v13 — Physical staging evidence and general recovery inspection

**Baseline:** matched M3v12 extension and plugin archives.
**Output:** VectHare `2.2.0-alpha.m3.17`, Similharity `3.2.10-m3.17`.

## Delivered

1. **Qdrant physical-stage readback checkpoints.** For a >256-record new-model stage, each 32-point Qdrant upsert is followed by an exact ID-based point fetch. Only matching payloads, IDs and vector values can create a durable, append-only checkpoint. A lost response, missing point or vector mismatch prevents a checkpoint and retains the existing one-use/lock guards.
2. **Private checkpoint evidence.** `m3-physical-progress.js` persists ordered, owner-bound, checksummed physical readback events tied to one operation ID, target backup UUID and inventory digest; files are `wx`, fsynced, and read-only via `GET /v2/m3/collections/rebuild/physical-progress/:operationId`. A stored checkpoint alone is never evidence that the *current* target is unchanged, nor permission to repeat a write.
3. **Administrator-only general reconciliation inspection.** `GET /v2/m3/operations/:operationId/reconciliation` collects durable operation audit, scoped job exclusion and ledger evidence, and performs fresh action-specific physical proof where available. Verified committed deletion (S02 tombstone + Qdrant 404) and verified staged rebuild may be labelled `VERIFIED_APPLIED_REVIEW`; active latest-generation restore/empty may receive the same label after full target receipt/readback. Unproven cases remain `REVIEW_REQUIRED`.
4. **Fail-closed client boundary and UI.** Browser paths are strictly GET-only, UUID-scoped, no client verdicts, vectors, owners, physical names, credentials, forced replay or lock release. New buttons inspect stage checkpoints and admin-only lifecycle reconciliation.
5. **New fault tests.** Verify immutable ordering, owner isolation, corrupted checkpoints, absence of replay authority, separate Qdrant point readback, inability to infer `NOT_APPLIED` from missing information, and refusal when backend or job evidence is insufficient.
6. **Version and integrity.** Updated both project versions and regenerated plugin S10 source fingerprint after all source changes.

## Not delivered / still blocked

- Safe restart and continuation of a *claimed, physically ambiguous* stage (the original claim and logical locks are still retained). **Physical staging is NOT fully resumable.**
- General administrator adjudication that reconciles every operation and releases or quarantines locks after sufficient evidence. The new generalized inspector is **read-only**; it does not create a resolution verdict or release a lock.
- Automatic `NOT_APPLIED` proof based on absence, automatic replay of uncertain dispatches, and unrestricted collection purge remain prohibited.
- Live SillyTavern/Qdrant certification was not performed; enabled functions are for user manual testing only.
