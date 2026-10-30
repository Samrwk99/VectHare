# M3 verification and evidence boundary

## Automated verification

- Similharity plugin: **682/682 tests PASSED** in one full Node suite run; `plugin-final.log`.
- VectHare extension: **1,177/1,177 assertions PASSED** across six partitioned/isolated test runs. See `extension-partition-{0,1,2,4,5}.log`, `extension-partition-3-final.log`, `extension-i07-separate.log`. One earlier partition crashed with a Node experimental VM SIGSEGV in the unchanged `i07-backup.node.test.mjs` test file; the isolated file subsequently passed all 10 assertions. Thus this is **not** represented as a clean monolithic run.
- M3 focused plugin tests include saved-file and managed-registry staleness, bogus owner/embedding/vector/physical name input, one-way plan claims, active job lease exclusion, full physical inventory no owner filtering, duplicate/foreign point refusal, backup integrity tampering, disposable restore staging with no cutover or source deletion.
- M3 focused extension tests check that the browser can only send scoped source selectors and exact confirmation phrases; it refuses injected text, vector, backend paths, owners, network URLs and unscoped purge.
- Plugin S10 build manifest regenerated from executable source (runtime local-fingerprint check, not proof of deployment authenticity).

## Real-host and capability status

- No running Qdrant was reachable at `127.0.0.1:6333`; no Docker or Podman was available. No SillyTavern host was available for acceptance.
- No real Qdrant restore, deletion, fresh inventory round trip or cutover was executed. The disposable restore test is a Qdrant-shaped fixture, **not** a real Qdrant instance.
- No M0/M1/M2 outstanding host acceptance was marked complete; no M3 operation was promoted to production `ENABLED`.
- Logical backups can be captured from eligible server-attested v2 collections by the new route but should be treated as **uncertified backups** until live restore and disaster-recovery drills pass. Do not rely on them as the sole protection for user data.
- `M3-CAPABILITY-MATRIX.json` retains all 70 backend-operation cells without invented live-evidence fingerprints. Current M3 preview/planning availability is described separately from production capability enablement.

## M3 acceptance gates still required

1. Prove full Qdrant-owned inventory + registry + source/ledger consistency on a disposable latest-stable SillyTavern host.
2. Restore from a generated logical backup into a fresh target and verify schema, every ID/payload/vector/revision, and fixed smoke queries on the real backend.
3. Implement and test a durable, trusted S02 logical-binding cutover and rollback primitive without breaking the canonical physical-name and scope invariants in F02, S05, S04, M1 and F03.
4. Implement and test consented quiesce → fresh backup → guarded collection deletion → authoritative absence/readback → tombstone; repeated and uncertain requests must never silently replay.
5. Reuse lifecycle for an owned-collection empty/reprovision, and reuse verified cutover for a model-change rebuild with M2 checkpointed re-embedding.
6. Complete all fault-injection gates (crashes before/after dispatch, registry commit, rename, lock, backup errors, interrupted restoration, repeated confirmations, concurrent M2 jobs and unrelated writers); certify per backend+operation using real-host evidence only.
