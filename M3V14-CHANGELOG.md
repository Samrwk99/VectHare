# M3v14 — M3 Qdrant implementation handoff

**Base:** matched M3v13 VectHare + Similharity archives. **New versions:** VectHare `2.2.0-alpha.m3.18`, Similharity `3.2.10-m3.18`.

## Changes

1. **M3 Qdrant physical staging continuation** (`m3-stage-continuation.js`, `m3-stage-resume.js`, `m3-logical-exclusion.js`). Added independently reverified complete physical scroll against immutable checkpointed prefix, saved-source fingerprint and staged embedding profile. Only when every physical point matches the verified prefix can a separately **administrator-approved** continuation run. It uses a **fresh operation UUID** and transfers *both* retained logical locks **in place** without exposing an unlocked gap. It re-observes the prefix, writes only remaining deterministic points in 32-point chunks, verifies each by exact readback, then requires complete target schema/inventory, smoke queries, immutable receipt and target registry before returning `VERIFIED_STAGED`. The claimed original operation is never replayed. A failed new dispatch retains both locks and forensic case files.
2. **General M3 proven-applied administrator lock quarantine** (`m3-general-adjudication.js`). Restore, scoped empty, and completed rebuild cases can request a fresh independently verified proof. Only a server-private one-use approval bound to that proof permits moving retained locks to forensic quarantine. Missing ledger, jobs, target evidence, dead-process proof or verified journal/registry evidence fail closed. No browser outcome assertion or synthetic `NOT_APPLIED` decision.
3. **General forensic abandonment** (`m3-abandonment.js`). An administrator may record an immutable `ABANDONED_UNCERTAIN_LOCK_RETAINED` disposition from an approved server-private evidence hash. Qdrant outcome remains `NOT_PROVEN`. The physical lock stays in place and the operation is never replayed. A running process, missing/changed evidence, owner mismatch or repeated adjudication is refused.
4. **Managed registry sizing** (`f09b4-managed-registry.js`). Raised the bounded managed registry to 20,000 entries / 16 MiB, matching the existing upper bound of Qdrant rebuild preparation. Added >2,000-record round-trip test. Actual capacity also depends on backend resources and the separate 95-MiB target-backup bound.
5. **GUI and request boundary**. Added controls for physical-prefix proof, approved new-operation stage continuation, proven-applied review/quarantine, abandonment and abandonment inspection. Every HTTP request is exact UUID + empty body where applicable. No frontend physical collection name, owner ID, vectors, administrator verdict, credentials or arbitrary path.
6. **Readiness and matrix**. New scoped Qdrant M3 capabilities report `ENABLED / AWAITING_MANUAL_TEST`, with runtime and external-approval preconditions. Existing 70-cell matrix retains 8 enabled, 57 blocked, 5 unsupported; the generic M2 record-job recovery block is narrowed to its actual missing contract rather than misrepresenting completed M3 adjudication.

## Safety and exclusions

- Unrestricted collection purge and legacy direct-write bypasses remain prohibited.
- An unknown Qdrant outcome cannot be inferred `NOT_APPLIED` from a missing record or response.
- No claimed uncertain physical write is silently replayed.
- Forensic locks remain when proof is insufficient; abandonment does not unblock them.
- Supported only on trusted single-host cooperative locking; Windows administrative lock transfer remains **unvalidated**, and the current implementation refuses it.
- Real latest-stable SillyTavern + Qdrant acceptance **not performed** in this workspace.
