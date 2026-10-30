# M3v11 → M3v12 handoff

**Prioritize completing the remaining M3 operations rather than another contract-only iteration.**

1. **Repeated owned deletion after cutover:** design an explicit historical-physical retention/deletion policy and transaction. A successful active alias DELETE must not misleadingly claim that retained earlier Qdrant collections are destroyed. Require complete per-generation backups, inventory/owner proof, a durable decommission receipt covering what survives, S02 tombstone, and no auto-replay.
2. **M2 resumable rebuild:** replace synchronous 256-record staging with bounded durable per-record jobs; crash/restart, checkpoint, budgets, source re-attestation and target-generation locking tests. Do not allow incompatible embeddings under an existing S02 identity.
3. **General uncertain adjudication:** bind claimed lifecycle stages to physical/ledger/registry/journal state; require authoritative applied/not-applied evidence, out-of-band administrator approval, and lock quarantine. Never infer `NOT_APPLIED` from absence after a destructive operation.
4. Manual acceptance on disposable latest-stable SillyTavern and real Qdrant remains the user's responsibility; do not disable other implementation-complete functions solely pending their tests.

**Known restriction:** The repeated restore/empty enhancement is Qdrant, same embedding profile, owned collections only. Cross-model transitions remain handled separately by source-scoped model activation.
