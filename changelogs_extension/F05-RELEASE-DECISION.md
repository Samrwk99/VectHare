# F05 release decision

**Decision: DEVELOPMENT / HOST-ACCEPTANCE CANDIDATE — NOT PRODUCTION-READY.**

The extended Qdrant acceptance workflow is implemented and offline-tested, including one real network-path Qdrant-shaped local HTTP fixture. Its real deployment to the user's Termux SillyTavern/Qdrant instance has **NOT** been tested from this execution environment.

The F05 extended diagnostic creates a fresh disposable namespace and uses only generated synthetic data. It does not change the ordinary public record mutation policy; existing `DENIED` production capability cells are correct. Successful Qdrant acceptance will NOT automatically make any individual production write safe or enable E02 matrix cells.

**Unresolved F05 activation gates:** real Termux/Qdrant acceptance with clean schema/owner indexes; exclusive-writer policy or independently proven atomic DB revision semantics; crash/restart durability and recovery of uncertain operations; actual host-attested source binding on normal memory paths; real embedding generation and final prompt retrieval; branch/user isolation; legacy data migration/backup/export; independent Windows/Linux acceptance where claimed.

**Next recommended stage:** collect real-host evidence, then implement and verify the main VectHare memory pipeline against the source-bound v2 API; do not relax write restrictions before those guarantees are established.
