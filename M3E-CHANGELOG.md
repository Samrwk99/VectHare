# M3e — Trusted restore transaction and post-cutover record lifecycle

Baseline: M3d VectHare `2.2.0-alpha.m3.3` and Similharity `3.2.10-m3.4`.
This package is Similharity `3.2.10-m3.5`. The extension executable is unchanged.

## Implemented in Similharity

1. Added an **internal one-operation restore → verify → publish** coordinator (`lib/m3-lifecycle-transaction.js`). It consumes a previously server-issued M3 restore ticket and previously saved logical backup. It does not accept owner, physical collection, raw text, vector, credentials, or backup filesystem locations from HTTP.
2. Added a process-local, non-forgeable logical-exclusion holder. The M3 cutover journal can now prepare and publish under the same held logical lock without a lock bypass or double-lock deadlock. External journal methods still use their own exclusion lock.
3. Before its one-way durable claim, the restore reattests canonical scope, saved file, embedding profile, F03 receipt, managed registry, complete owned physical inventory, M2 lease and unsettled S04 receipts. A pre-claim rejection releases its lock; failure after claim **retains the logical lock** and cannot be replayed silently.
4. Fresh-target Qdrant creation and index provisioning reuse the existing physical staging algorithm, but now require the internal lifecycle holder for non-disposable transports. The coordinator then checks complete payload/vector inventory, runs fixed-version Qdrant smoke queries, issues an immutable generation-specific target receipt, and records journal `PREPARED → PUBLISHED`. The old collection is retained, not deleted.
5. M1 source-owned record preview/planning and guarded S04 execution can now consume a server-verified published target, including immutable receipt, live Qdrant checks and a generation fence immediately before dispatch. The canonical F03 receipt is still required.
6. After a legitimate post-cutover mutation, the target can evolve beyond its immutable initial backup inventory. Verification requires **all** physical rows to match the active managed registry, plus a verified S04 ledger receipt for every changed/inserted/deleted record on the exact target generation. Pending/uncertain operations or absent ledger evidence fail closed.
7. An in-flight M1 post-dispatch ledger readback uses journal-generation/source checks without requiring the managed registry to have prematurely committed; ordinary new read/plan requests still require full inventory/registry/ledger reconciliation.
8. Updated release manifest to `3.2.10-m3.5` and regenerated the 84-file S10 local source integrity manifest.

## Not delivered / not claimed

- The **public** `/v2/m3/collections/execute` route remains intentionally blocked. `executeM3TrustedRestore` is an internal server-side API, **not** public or live-host certified.
- Collection decommission/delete, scoped empty/purge, automatic restore resume/checkpoints and full reversible cutover, embedding-model rebuild and the full M3 public UX remain incomplete.
- Nothing here certifies Qdrant real-host behavior or upgrades any production capability. The 70-cell matrix remains blocked.
- No M3 extension executable change was necessary. The companion ZIP preserves M3d/M3c's controls and denials.
