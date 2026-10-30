# M3v12 → M3v13 handoff

The code supports repeated Qdrant active-generation deletion with retained historical physical collections and checkpointed, predispatch large-rebuild embedding preparation. Both are enabled for controlled **manual testing**, with separate limitations recorded.

**Next priority:** Finish general uncertain-operation adjudication with verified backend/ledger/registry/journal evidence, administrator approval and lock quarantine. Reconcile physically ambiguous operations without inferring `NOT_APPLIED` from absence or replaying a submitted destructive operation. Integrate the rebuild worker with the general M2 coordinator for physical-stage progress if lossless resumability is required; current checkpointing is limited to embeddings before physical dispatch. Preserve cross-model source scope, backup-first collection deletion, tombstones, and the unscoped purge prohibition.

**Testing limitation:** No live SillyTavern/Qdrant acceptance performed here. Automated tests use disposable Qdrant-shaped fixtures. Do not mark real-host verification complete until the user runs the manual acceptance guide.
