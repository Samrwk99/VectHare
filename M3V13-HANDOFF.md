# M3v13 → Remaining M3 work

M3v13 adds durable, per-chunk physical-write **evidence**, not a restartable writer. The requested M3 finish line is still incomplete.

## First: make physical Qdrant stage truly resumable

Use the existing immutable operation/target manifest, chunk events and full current-target inventory proof to design a **new, explicitly authorized continuation transaction**. Require a fresh process-liveness fence, backed-up target, source/model revision attestation, backend-specific proof of idempotent deterministic point IDs, verification of EVERY already written point and absence of foreign points, and durable intent/checkpoint per new chunk. Never reuse the old operation UUID or auto-unlock uncertain locks. Treat missing readback and partial/unattributable writes as `BLOCKED_UNCERTAIN`, not permission to resume. Then integrate pause/cancel, bounded worker ticks and M2 job accounting. Test before/after each dispatch, crash/restart and competing process.

## Second: finish general adjudication

Extend `m3-general-reconciliation.js` with action-specific authoritative proofs and an administrator-controlled, hash-chained, one-operation decision file matching the M2 recovery contract. Require independent logical/physical locks, journal generation, S02/F09b4 registry and S04 ledger reconciliation, backup retention and a dead-process check. Permit lock quarantine/release only for sufficiently proved dispositions, with forensic retention. `NOT_APPLIED` must be independently established; do not infer it from absence or a missing ack.

## Third: user acceptance

Test on a disposable latest-stable SillyTavern + Qdrant. On M3v13, inspect checkpoint progress via the M3 GUI while staging >256 records, then inspect the general reconciliation view as an admin for any claimed operation. Keep the matrix's existing Qdrant completed operations `ENABLED / AWAITING_MANUAL_TEST`; do not enable the general `uncertain-recovery` cell until real adjudication exists. No replays, unsafe purges or unowned deletes.
