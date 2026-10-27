# VectHare — C07 Foundation Checkpoint (2026-10-27)

**Base:** `VectHare-I18-Phase0-C01-C04AB-C06AB-C11AB-C03-Checkpoint.zip`.
**Plugin:** Similharity plugin **untouched**; supplied source used only as reference.
**Scope:** Stage 4 of the dependency-adjusted plan: *C07 foundations*, not all 14 C07 issues and not physical backend ID migration.

## Code changes

1. `utils/record-identity.js` (new, no host imports): collection-qualified logical `recordId(collectionKey, localId)`, safe diagnostic keys, versioned FNV-1a 64-bit UTF-8 content fingerprint (`vh-fp2-fnv64`), membership-based group IDs, explicit hash collision analysis, per-chat UID stamping, positional reconciliation, scene boundary reconciliation, and parent/link/summary reference remap proposals. This code does **not** authorize physical vector writes/deletes/migrations on its own.
2. `core/chat-vectorization.js`: stamps extension-owned message UIDs under `message.extra.vecthareMessageUid` when a verified `chat_metadata.integrity` and callable host `saveChat()` are available. Saves before accepting newly stamped UIDs, rolls them back on rejected/failed save, prevents stale jobs from using a changed chat, and keeps potentially saved UIDs on post-save cancellation. When persistence cannot be attempted, retains positional legacy behavior without claiming UID durability. Adds messageRefs, speaker metadata, logicalGroupIds, logical recordId and contentFingerprint to grouped chunks, while **keeping physical backend hash unchanged**. Duplicate *identical* raw text is merged into one hash-backed record with distinct membership references. Different raw texts sharing a hash abort that grouping operation.
3. `core/scenes.js`: new scenes may carry `sceneStartRef`/`sceneEndRef`, anchored to chat-qualified message UIDs. Scene lookups resolve those boundaries against the current chat. Missing, duplicated, foreign, half-migrated or reversed anchors fail closed instead of interpreting stale indices. Legacy positional scenes are not auto-migrated.
4. `core/core-vector-api.js`: `getSavedHashes(includeMetadata)` detects duplicate listed hash identities; metadata of ambiguous records is returned as unknown/null, with `metadataStatus: 'ambiguous'`, instead of silently joining the last row by hash.
5. `ui/search-debug.js`: trace fates are keyed by collection/record identity where supplied. Later stages lacking a collection reference cannot attach an ambiguous same-hash fate to the wrong collection; such fates are marked unresolved.
6. `core/collection-export.js`: preserves newly introduced reference and fingerprint fields in exported metadata. Existing import, export completeness and physical hash migration restrictions are unchanged.
7. `core/world-info-integration.js`: resolved `entryUid` takes priority over legacy `uid` or chunk hash when identifying an activated World Info entry.
8. `tests/c07-record-identity.node.test.mjs`: 40 new pure and extracted-real-function tests; `npm run test:c07` added.

## Deliberate restrictions / deferred C07 work

- **No physical record-ID migration**. Legacy Standard hash remains the storage key and other adapters still use their current on-wire identity contracts. Client-assigned physical IDs and updatePayload require verified server capability (C06 and final C07).
- **No unverified delete/re-embedding**. Positions and references are emitted as proposals, not auto-committed; C02 must implement verified replaceRecords, journal and migration with rollback.
- **No automatic legacy reference migration**. Existing positional scenes and hash-only links remain for a reviewed/dry-run migration.
- **No promise of durable host save**. A resolved `saveChat()` call is not a server-backed durable acknowledgement. Actual SillyTavern reload/branch/copy tests remain mandatory.
- **No alteration of old collection-level vectorizationConfigFingerprint**: upgrading that field without a compatibility-aware migration would block or incorrectly validate existing collections. The new versioned fingerprint currently identifies content metadata. The configuration fingerprint migration remains pending.
- Collision checking currently covers each newly grouped input batch. Identifying a collision **against existing stored records** requires authoritative complete backend inventory and identity comparison, not only existing hash lists. Such acceptance remains blocked.
- Consistent speaker-prefixed embedding text, all legacy link remap call sites, position-only updatePayload and UI repair remain dependent work in full C07/C02.
- C01 live deletion/global purge restrictions remain enabled, because the supplied plugin cannot yet prove safe tenant-scoped operations or durable commit receipts.
