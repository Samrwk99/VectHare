# M3v5 — scoped owned-collection empty/re-provision

Baseline: M3v4 VectHare and Similharity packages.

## Completed changes

- Added server-only `lib/m3-empty-transaction.js` for canonical owned Qdrant collections. An immutable pre-existing verified logical backup and full managed provenance are required.
- Added a one-use durable lifecycle claim, logical collection lock, pre-dispatch checkpoint and no-replay-on-uncertain policy.
- Stage a *fresh empty* same-schema Qdrant physical collection; independently verify complete zero-point inventory and required indexes. Preserve original physical collection and backup.
- Persist a separate immutable zero-point target manifest; mark the complete managed registry as `DELETED` tombstones while the logical lock is held, then publish a versioned journal generation.
- Verify published target via immutable receipt and physical readback. Explicit record restore is required for later resurrection; automatic sync does not silently clear tombstones.
- Exposed operation through typed server-issued plan and exact `EMPTY OWNED COLLECTION` confirmation, plus guarded VectHare UI controls.
- Added scoped-purge to Qdrant-only M0 server capability evidence. 70-cell matrix is 8 ENABLED, 57 BLOCKED, 5 UNSUPPORTED_BY_DESIGN.
- Added fault tests for stale-source refusal, successful empty and retained uncertain lock after a lost Qdrant create response. Other M3 and legacy mutation gates were not removed.

## Boundaries

New-model rebuild, privileged uncertain-lock reconciliation and general post-cutover collection deletion are **not** implemented. No real-host acceptance was performed. Unscoped `/purge-all` stays permanently prohibited.
