# VectHare — C04-B / C06-B / C11-B prerequisite checkpoint

**Base archive:** `VectHare-I18-Phase0-C01-C04A-C06A-C11A-Checkpoint.zip`.
**Nature of this delivery:** local source/contract groundwork with fail-closed activation; **not live contract certification** or completion of full C04/C06/C11.

## C04-B — canonical ownership and safe registry migration

- Added `utils/c04-registry-migration.js`: a pure `planRegistryMigration()` dry run over collection registry, collection metadata, selected-chat policies and scoped chunk metadata, with explicit legacy→qualified mapping, ownership review, collision reporting, version `2`, idempotence checks, backup and guarded rollback. No vector data is moved. `commitRegistryMigration()` requires explicit approval and a callback acknowledging *durable* persistence. It refuses stale plans, unresolved aliases, conflicts and snapshots larger than 2 MiB in ordinary settings; rollback refuses to overwrite post-migration changes. **No automatic commit or settings-version bump occurs at startup.** The host's `saveSettingsDebounced()` is not accepted as durable proof.
- Added `utils/c04-ownership.js`: exact persisted chat/character origin checks, exclusive lock checks, and import quarantine with preserved lock references. A filename/chat index is not accepted as a verified owner.
- `core/collection-ids.js` now exposes `getVerifiedChatOriginId()` (chat metadata's persisted integrity ID only; legacy filename fallback remains separate for compatibility).
- New content-vectorized collections register `backend:source:collectionId` keys and attach verified chat origin if available. New chat/character collections without a verifiable origin are disabled pending review; no automatic owner reassignment.
- Backup exports now preserve old/new lock fields and origin fields. Importers preserve behavior settings but do **not** silently enable imported collections; they require explicit approved/verified owner remapping.
- `core/collection-metadata.js` no longer auto-migrates and deletes old scattered enabled flags without verified ownership. Unresolved legacy metadata is read as disabled without destroying the existing stored record. Chat policy selection cannot match two different backend keys by bare ID, and unqualified/ambiguous selections are not forced into retrieval.
- `utils/c01-deletion.js` now prunes exactly the deleted qualified key from chat selections during durable finalization and restores policies if finalization persistence fails.
- Plugin discovery/fallback probing no longer unregisters or auto-migrates stored registry entries from incomplete/failed/empty results. Plugin discovery validates qualified keys and no longer aliases sanitized collection names to possibly different physical owners.

## C06-B — stricter contract abstraction

- Added `utils/c06-scoped-facade.js` for new, qualified, collection-scoped calls. It validates backend/source, requires independent tenant and operation-ack capability evidence, enforces scoped query results, and classifies partial or lost write acknowledgements as uncertain. A read-only, exact-key paginated inventory operation requires a separate scoped count and pages. **Existing callers are not all migrated to the facade yet.**
- Added `utils/c06-contract-audit.js` to validate locally supplied per-backend endpoint/evidence manifests. Reports are advisory only (`unverified` or at most `candidate`), never set runtime verified capabilities. Four existing `tests/contracts/*.json` ledgers have no pinned deployed server source, commit or live receipts, so live tenant filtering, count and purge acknowledgement remain unknown. External SillyTavern server-plugin documentation describes routing but does not prove a specific Similharity version.
- No shared-physical collection purge is unlocked, and C01 destructive paths remain blocked.

## C11-B prerequisites — reliable inventory/discovery evidence

- `utils/c11-adapter-inventory.js` now requires independent verified capabilities for scoped pagination, complete inventory, tenant filtering **and count**. It requires explicit `listScopedPage` / `countScopedRecords` adapter contracts, not the inconsistent legacy `listChunks()` response. These methods are not yet implemented for deployed servers, so the bridge remains unavailable by design.
- `utils/c11-paginated-inventory.js` now requires **every record** to explicitly assert its exact qualified collection owner. Previously missing owner fields could pass.
- Plugin discovery is informational only: neither a missing collection on a plugin list nor a failed probe can authorize registry removal or a legacy remap.
- Legacy JSON export is now labeled `inventoryComplete:false` / `inventoryStatus:'unverified'`; it refuses responses reaching its 50,000-record API cap rather than silently exporting potentially truncated data. This is **not yet the C11 full paginated/streaming exporter**.

## Verification

- Existing I01–I18: **199/199**.
- Phase 0: **33/33**.
- C01: **35/35**.
- Prior C04-A/C06-A/C11-A dependency suite: **24/24**.
- New C04-B/C06-B/C11-B suite: **31/31**.
- **322/322 tests**, plus JavaScript syntax checks.
- All fixtures are local. No live Qdrant/Milvus/LanceDB or SillyTavern+Similharity server test occurred.

## Intentional compatibility effects

- Unmapped restored collections and existing unqualified legacy registry entries may now be disabled in retrieval pending explicit migration. This prevents an old owner flag from enabling an unrelated backend tenant.
- Backups exported through the legacy plugin list are explicitly *not certified complete*. Do not use them as authoritative recovery evidence.
- The new registry-migration commit/rollback APIs are not connected to ordinary debounced SillyTavern settings because durability is not verifiable.
