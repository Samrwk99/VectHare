# VectHare — C02 implementation checkpoint changelog

Date: 2026-10-27
Baseline: `VectHare-I18-Phase0-C01-C04AB-C06AB-C11AB-C03-C07-Foundations-Checkpoint.zip`.
Plugin: `VectHare-Similharity-Plugin.zip` inspected **read-only**, unchanged.

## C02 additions

1. `utils/c02-operation-journal.js` — IndexedDB operation journal with schema versioning and transaction-completion acknowledgement. Stores allowlisted operation IDs, qualified collection keys, operation kinds, old/new record IDs, versioned item digests, verified ID progress, state, timestamps and allowlisted reason codes. **No raw text, vectors, credentials or arbitrary backend errors are stored.** Explicit test-only memory journal; no runtime memory fallback.
2. `utils/c02-replacement.js` — injected `createC02Coordinator()` implementing `replaceRecords()`, `reconcileBatch()`, `resumeMissingRecords()` and `recoverPendingOps()`; FIFO collection lock, insert → verified scoped inventory → old-minus-new deletion → post-delete inventory → commit, with durable staged/verified/needs-reconcile/committed checkpoints. Reconciles lost insert acknowledgements by listing rather than automatically retrying. Resume requires same source fingerprints, independently verified idempotent upsert, and complete scoped readback; only missing IDs are resent. Recovery never blindly retries deletes.
3. `core/core-vector-api.js` — eliminated unsafe automatic resend of non-idempotent writes in both server-side and client-generated-embedding insert loops. Exposed pending journal recovery and a collection-qualified `replaceVectorRecords()` entry point; blocked legacy direct text re-embedding. Live C02 replacement requires pinned `listPagination`, `completeInventory`, `count`, `getByIds`, `insertAcknowledgement`, tenant scope, and (when deleting originals) `deleteAcknowledgement` plus a working scoped inventory bridge. They remain unverified for the supplied plugin; **writes to these unsafe C02 workflows are blocked before dispatch**, not falsely treated as completed.
4. `core/collection-export.js` — import source validation and duplicate-hash refusal; nonempty single/multi imports route through C02 replacement instead of accepting an opaque write as success. Metadata and registry activation run only after committed proof. Existing overwrite purge remains refused. Direct-vector import uses physical backend/source-qualified routing.
5. `ui/chunk-visualizer.js` — both manual text editors and bulk text edit path now require journal-backed replacement before mutating local chunk/hash metadata. Pending per-chunk changes stay pending when a write cannot be confirmed. Newly added summaries cannot be reported saved from an uncertain insertion.
6. `core/scenes.js` and `ui/scene-markers.js` — new scene vector must have a confirmed C02 outcome before individual message chunks are disabled. Scene split no longer deletes the original scene before replacement proof; it is intentionally unavailable with the current plugin.
7. `index.js` — checks durable C02 pending operations at startup, shows reconciliation warning; never silently resumes or deletes vectors after a reload.
8. `tests/c02-operations.node.test.mjs` — 50 fault/inventory/journal/resume tests, including simulated IndexedDB reload, lost insert/deletion ACK, partial committed writes, cancellation, content drift, ownership and lock contention.
9. `tests/c02-integration.node.test.mjs` — 11 live-module import and source-integration checks, including refusal to activate metadata after uncertain imports and safe editor/scene guards.
10. `package.json` — `npm run test:c02` entrypoint. Existing backup/provider regression harnesses updated to include an explicitly simulated confirmed C02 coordinator.

## Explicitly not claimed

The supplied plugin does not currently furnish an authoritative, complete tenant-scoped ID inventory, proven idempotent upsert or trustworthy scoped-delete completion semantics across all four adapters. Browser IndexedDB is durable for its own transaction, **not** a distributed transaction with the backend. No end-to-end atomicity, exactly-once guarantee, live import/re-embed/scene replacement compatibility, cross-tab lock or server-backed recovery is certified.

No plugin files or backend server source were modified. No previously blocked C01 purge/deletion capability was enabled. Future C02 activation depends on the C04/C06/C11 contract implementations plus disposable live acceptance tests.
