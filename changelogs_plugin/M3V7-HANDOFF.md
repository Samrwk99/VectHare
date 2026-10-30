# M3v7 → M3 completion handoff

## Highest priority: execute new-model rebuild, not another preview-only iteration

1. Add a **server-controlled staged embedding profile** while preserving the current active profile. Keep provider credentials private and bind both identities to source scope. Do not flip the active source/model/dimension at staging time.
2. Build an M2 bounded job from the saved-source mapping checked by `previewM3ModelRebuild`. No browser-supplied text/vectors. Deterministic record IDs, revisions, tombstones and source metadata preserved. Each record's new vector must match the target model and dimension, with one-by-one durable receipts and pause/resume at safe boundaries.
3. Provision a completely distinct Qdrant collection under the **new** S02 key and F03 schema, verify full inventory/metadata, receipt provenance, embedding profile and smoke queries; lock both logical keys while staging and switching.
4. Implement a single durable, consented **profile-and-binding cutover** changing the active configured profile and collection routing together. An interrupted operation must be blocked for adjudication rather than exposing an empty new collection. Retain old collection and profile for rollback; refuse destructive cleanup until backed up.
5. Reuse the per-generation alias-backup path from M3v7. Repeat delete/empty/restore on aliases only when full source/target receipts, current registry, active generation, original backup and physical inventory can be attested in one transaction. Never simply remove `guardM3CanonicalBinding`.
6. Implement M2 admin adjudication for truly uncertain physical lifecycle dispatches using ledger/journal/physical proof, not unchecked replay or automatic unlock.
7. Enable M3.5 in matrix only when the **complete user-facing operation and fault tests** pass. Manual host testing can then follow per v4 policy.

## Operational note

M3v7 backup of an already cut-over target is now possible when the immutable target receipt and actual inventory are valid. Those backups are not presently eligible for destructive plans; repeated collection mutations still need explicit generation-scoped lifecycle orchestration.
