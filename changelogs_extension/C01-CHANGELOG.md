# VectHare — C01 Safe Destructive Cleanup (local implementation)

Baseline: `VectHare-I18-Phase0-P09-Hotfix.zip`. Existing I01–I18 fixes, the 12 Phase 0 work packages, and the P0-9 cancellation correction are preserved. **C01 is implemented to a conservative local/mock-tested safety checkpoint, NOT live-backend certified.** No C02–C14 system is claimed complete.

## Work by C01 issue

### #158 — Orphan status and protected/shared metadata
- Added collection-qualified record metadata storage/read/delete functions (`saveScopedChunkMetadata`, `getScopedChunkMetadata`, `deleteScopedChunkMetadata`) preserving distinct `recordId` values across collection keys.
- Added `mayRemoveLegacyHashMetadata` guard: all potentially owning qualified collections must have complete explicitly terminated record inventories, and the hash must be absent from all, before considering a global legacy hash removable.
- Disabled `deleteChunkMetadata(hash)` hash-only deletion because existing global hash metadata cannot prove exclusive ownership. **Behavior change:** old UI/diagnostic hash-only deletion can now leave legacy metadata intact rather than risking cross-collection data loss. Existing reads/writes of legacy metadata are not migrated by C01.
- Diagnostic orphan repair now reports that reconciliation is required rather than deleting globally shared hashes. Sync checks cannot assert orphanhood without backend ownership capability.
- Added a namespace gate to the destructive storage diagnostic and prevent creating disposable vectors where verified cleanup is not possible.

### #189 — Authoritative backend-qualified inventory
- Added explicit record and collection inventory collectors (`utils/c01-inventory.js`) with tenant/source verification, cursor-loop checks, positive end-of-list evidence, capped/failed/unknown result classification, and optional count reconciliation.
- The Database Browser no longer passes a partial, empty-filtered UI list to automatic metadata deletion. Collection metadata lookup no longer guesses between same-bare-ID owners.
- `cleanupOrphanedMeta` rejects unverified inventory; available evidence must be backend/source qualified. **Real adapters have no verified pagination contract in this ZIP, so live inventory cannot authorize cleanup.**

### #216 — Tombstone → purge → verify → finalize
- Added `utils/c01-deletion.js`, including keyed mutex operation, owned registry and metadata preflight, required durable checkpoint acknowledgement, optional protected export receipt, a `deleting` companion tombstone, `purge-sent` checkpoint, purge acknowledgement, post-purge confirmed empty readback, and scoped registry/metadata finalization.
- An acknowledgement lost after commit never causes a blind second purge; a later verified empty readback can resolve the tombstone without repeating the delete request. Failure keeps retry/reconciliation references.
- Startup detects pending markers and shows a warning rather than silently retrying destructive requests.
- Actual `deleteCollection` now routes through the C01 coordinator, verifies exact backend/source, and refuses unverified real server contracts. Direct purge and global purge remain explicitly fenced from future accidental activation by separate contract gates.
- **Live blocker:** a debounced SillyTavern settings save is not proven durable, and pinned backend list/purge/count/tenant contracts are unavailable. The production path therefore supplies *no* successful durability or backend evidence and does not submit a purge. The deterministic fake-backed coordinator exercises the full intended sequence; it is not a live compatibility test.

### #220 — Explicit metadata capability
- Standard native fallback no longer claims that missing text or `{}` is genuine backend metadata; it returns `metadataStatus: 'unavailable'` and `complete:false`.
- Metadata-enriched `getSavedHashes` returns `metadataStatus: available|unavailable|unknown`; missing per-record metadata is `null` rather than an asserted empty object. The error fallback returns explicit `unavailable` evidence.
- Collection metadata proof distinguishes `{}` (present) from null/undefined/missing (unavailable/missing).
- Backend metadata support remains `unknown` until a pinned real server proves it. All metadata-dependent destructive actions remain unavailable without that proof.

## Test coverage

- `npm run test:repair`: 199/199 pass.
- `npm run test:p0`: 33/33 pass.
- `npm run test:c01`: 35/35 pass, deterministic local tests, including two-tenant shared hash, unverified/partial/cross-scope/paginated inventory, expired cursor, count mismatch, crash recovery, lost ACK, persist failure, duplicate request prevention, protected export, scoped metadata and exact collection deletion.
- Syntax check of all JavaScript/ES modules and ZIP integrity are in the verification report.

## Remaining limitations / work

1. Pin user-deployed SillyTavern/Similharity server revisions and prove real adapter capabilities, including tenant-filtering, end-of-list pagination, purge ACKs, post-purge count/readback and protected-vector metadata (C06/C11).
2. Provide a genuinely acknowledged durable tombstone/checkpoint store for the runtime (C02/C03 dependencies). `saveSettingsDebounced()` alone cannot be treated as such.
3. Wire verified real adapter methods and transaction authorization into the C01 coordinator once those proofs exist. No live real-backend destructive delete is enabled in this build.
4. Complete migration of old hash-global chunk metadata to `(qualifiedCollectionKey, recordId)` with backup/rollback; legacy metadata reads and writes remain for compatibility (C04 stage B).
5. Provide production UX for export-before-delete and explicit operator reconciliation of failed/in-progress tombstones, backed by verified capability.
6. No live smoke tests ran. This checkpoint must not be labeled fully C01-complete or deletion-ready.
