# M3e handoff — finish M3 before M4

Start from `VectHare-M3e.zip` and `Similharity-M3e.zip`.

## Next implementation tasks, in priority order

1. **Production restore completion and host certification:** Complete durable per-chunk restore checkpoints, signed administrator-approved real-host evidence and an authenticated user-facing restore workflow. Only dispatch when the exact backend + operation passes real SillyTavern + Qdrant acceptance. Preserve one-way claim and retained lock for all unresolved post-dispatch outcomes.
2. **Cutover rollback and post-cutover lifecycle:** Use the same private logical lease to validate and publish a new, receipt-backed rollback generation. Reattest source, registry, current physical target and M2 lease. Test an active M1 write and a rollback racing; stale tickets must never reach dispatch. Keep the original restored collection until rollback retention policy permits disposal.
3. **Owned collection decommission:** Mandatory logical backup, complete *unfiltered* physical inventory equals managed registry, no M2 lease or unsettled S04 receipt, server-issued destructive consent, durable one-shot claim + logical/physical lock, exactly one backend collection delete, absence readback and durable S02 `DELETED` tombstone. Any ambiguous delete preserves mapping and locks for adjudication. No generic `/purge-all`.
4. **Scoped empty:** Reuse decommission then re-provision an identically attested schema/embedding and update logical binding with a journal generation, preserving all receipts and tombstones.
5. **New-model rebuild:** Create a new collection with the new embedding profile; re-embed only attested saved sources using durable M2 jobs, verify full registry/inventory and fixed smoke queries, then cut over through the same journal. Keep the original target for rollback.
6. **Real-host gates:** Test real latest-stable SillyTavern and Qdrant (including outstanding M0/M1/M2 idempotency and uncertainty requirements), then backup, fresh restore, M1 operations after cutover, crash injection, rollback, collection delete, empty and rebuild. Promote individual cells only with attributable evidence.

## Critical design constraints

- The backup receipt is an immutable *cutover checkpoint*, not an assertion that a restored collection can never change. After publication, every change must be explained by the canonical managed registry and a `VERIFIED` S04 ledger mutation for the active generation. M3e now implements this rule for source-owned M1 mutations.
- M1's post-dispatch readback runs while its registry record is `WRITE_PENDING`, so it must use the existing in-memory verified binding and journal generation fence; a fresh unrelated read/plan must perform the full managed/ledger check.
- The internal `executeM3TrustedRestore` is **not an exposed/authorized HTTP action**; its presence is not permission to mark restore or cutover enabled. Do not remove the public M3 refusal to shortcut acceptance.
- Never bypass the S01/S04 write safety gates, weaken ownership or make a lock autorelease after an uncertain physical operation.
