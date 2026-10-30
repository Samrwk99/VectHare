# VectHare M3 continuation — v2 plan, second implementation pass

**Baseline:** VectHare `2.2.0-alpha.m3.1` + Similharity `3.2.10-m3.1` (previous partially implemented M3 packages).
**Output:** VectHare `2.2.0-alpha.m3.2` + Similharity `3.2.10-m3.2`.
**Classification:** Additional M3 code and tests delivered; **M3 exit gate remains OPEN**. Do not move to M4 as if M3 was finished. No production capabilities promoted.

## Code delivered in this continuation

1. Added `lib/m3-cutover-journal.js`, a server-only append-only, checksum-chained per-user/per-logical-key Qdrant cutover control plane. Journal events have monotonic generations and typed PREPARED/PUBLISHED/ABORTED states, one-way exclusive transition lock, owner/physical-name/key validation, fsync-backed immutable event append, and a previously confirmed active physical mapping. The reversible primitive is implemented as a **new evidence-backed switch generation**, not deletion or silent rewinding of history.
2. If a transition is prepared or a transition lock survives a crash, public canonical binding resolution now **fails closed** with `M3_JOURNAL_TRANSITION_REVIEW_REQUIRED`. If an alias is published, normal F02 reads and M3 preflight now **fail closed** with `M3_ALIAS_GATEWAY_INTEGRATION_REQUIRED`, preventing an erroneous fallback to the original physical collection. The journal is **not** a production cutover implementation until the other contracts can consume the alias.
3. Refined transition-lock handling so a proven pre-append validation rejection releases the journal lock, while ambiguous/durable append failures retain it for review.
4. Added `stageM3DisposableDecommission`, a **strictly internal disposable-only** Qdrant delete conformance routine. Requires an exact intact backup, complete full-collection physical inventory, complete active managed-record provenance, server-bound owner, typed confirmation, explicit writer boundary and disposable-fixture marker. It verifies physical absence after delete and returns UNCERTAIN on ambiguous dispatch/readback; it cannot be reached from the public M3 execute route. It does **not** create a production S02 deletion tombstone.
5. M3 collection context now enforces the journal consistency guard even when server-side bindings are injected, before backup, plan or preview access. Extension M3 description explains pending cutover/alias blocking.
6. Added journal tests for interruption, bad ownership/evidence, corrupted records, aborted operations and explicit rollback; expanded M3 tests with stale-canonical refusal and disposable delete fault cases. S10 executable source integrity manifest rebuilt, code and versions updated.

## Deliberately still blocked

- `/v2/m3/collections/execute` remains a hard denial. No physical production collection deletion, re-provision/purge, cutover or rebuild route was opened.
- A PUBLISHED alias currently **blocks** existing read/write consumers instead of enabling them. Completing M3 requires a coordinated alias contract in F02/S05/S04/M1/F03, including a new target provisioning receipt, registry-tombstone handling and locked host acceptance. The journal alone is NOT that contract.
- Restore and decommission conformance probes are fixture-only; no latest-stable disposable SillyTavern or live Qdrant was available.
- Existing M0/M1/M2 acceptance gates and M2 physical-lock adjudication prerequisites remain outstanding.

## Unchanged safety policy

No browser-supplied physical names, source text/vectors, owner IDs, backup file paths or DB credentials. No legacy `/chunks/*` mutation bypass and no `/purge-all`. No auto-clearing an uncertain physical lock, no replay of ambiguous delete/restore, and no fake ENABLED values.
