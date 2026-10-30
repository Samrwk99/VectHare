# M3g → M3h handoff — remain on M3

Start only from `VectHare-M3g.zip` and `Similharity-M3g.zip`. Preserve `M3G-CAPABILITY-MATRIX.json` statuses.

## Next technical priority

1. **Unify M3 with M2 assisted adjudication and S04 receipts:** bind audit stage hashes, operation claims, retained logical/physical locks, registry and physical inventory to a one-operation administrator review flow. Make recovery produce verified conclusions but NEVER interpret a stage checkpoint alone as applied/not-applied. Add fault-injection at claim, before/after physical dispatch, after readback, journal publish and terminal registry changes. Authoritative evidence is required before lock release.
2. **Complete public gated lifecycle dispatcher and explicit consent:** narrow trust-boundary types for restore, rollback, owned collection delete; short-lived token, owner/source re-attestation, mandatory backup and complete physical inventory, durable receipt and one-shot logical lock. Do not open public `/execute` until all predicates and live-host acceptance gates pass.
3. **Implement scoped empty:** mandatory backup and decommission semantics, create fresh equivalent-schema target under a new versioned mapping, ensure old S02 tombstone/lineage is preserved and old vectors are not resurrected, verify active routing and query smoke tests. This is not unscoped purge.
4. **Implement new-model rebuild:** profile-validated fresh target, bounded M2 source-attested re-embedding, inventory/schema and smoke verification, generation-fenced cutover and retention of original for rollback. Never mix embedding profiles in place.
5. **Design general lossless rollback:** current M3f rollback correctly refuses diverged post-cutover inventories. Create a verified lossless merge/copy mechanism or maintain refusal, and classify limitations honestly.
6. **Acceptance:** run disposable latest-stable SillyTavern with real Qdrant and inherited M0/M1/M2 tests. Only operation-specific passing evidence can move matrix cells to `ENABLED`.

## Do not regress

S01 denied legacy writes; S04 gateway and M1 generation fences; M2 quarantine; mandatory logical backup; ownership completeness; `withM3LifecycleExclusion`; per-operation immutable evidence; no physical URL or name from browsers; no automatic uncertain-op replay; no forced lock removal. Native Standard stays independent.
