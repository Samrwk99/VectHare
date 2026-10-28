# S01 — Similharity Critical Server Safety Checkpoint

**Date:** 28 October 2026  
**Plugin checkpoint:** `3.2.1-s01.0`  
**Input:** the user's unchanged `VectHare-Similharity.zip` (package version 2.0.0, internal version 3.2.0).  
**VectHare extension:** Not modified.

## Implemented

1. **Fail-closed legacy routes:** POST `/chunks/insert`, POST `/chunks/delete`, POST `/chunks/purge`, POST `/purge-all`, and PATCH `/chunks/:hash/text` and `/chunks/:hash/metadata` now return HTTP 409 with `code: S01_MUTATION_BLOCKED` and `success:false`, without processing a mutation. Two defenses are installed: early middleware and explicit refusing route handlers. This applies to **all four plugin backends** temporarily; it does **not** mean they are permanently unsupported.
2. **Backend-level refusal:** Qdrant and Milvus `insertVectors`, `deleteVectors`, `updateItem` and purge methods are replaced with explicit refusal; Qdrant metadata updates are refused, too. LanceDB destructive legacy methods are likewise refused. The unscoped physical purge functionality has been removed from these methods.
3. **Qdrant dimension check:** `ensureCollection` now compares the actual existing unnamed vector schema and dimensions and refuses absent, unknown or incompatible schemas without modifying the existing collection. The old insertion path that purged on mismatch has been removed. `ensureCollection()` is verification-only for S01 and cannot create collections. Shared insert remains denied until stable scoped point IDs and verification are implemented.
4. **Milvus dimension check:** `ensureCollection` now refuses missing vector fields, unknown dimensions, incompatible dimensions, and describe failures; there is no automatic collection drop. Initialization no longer creates/changes the shared collection. `ensureCollection()` is verification-only for S01: it cannot create collections or indexes.
5. **Qdrant startup:** Initialization no longer auto-creates payload indexes on existing collections. These are data/schema mutations and must become explicit authorized setup in a later checkpoint.
6. **Error semantics:** Qdrant and Milvus selected read operations now propagate backend errors instead of returning `[]`, `null`, `false`, or zero-like statistics. Genuine absence remains an ordinary empty result. This is a **targeted S01 improvement** rather than a complete API error-contract redesign.
7. **Qdrant HTTP retry safety:** The request helper gets a new abort controller per attempt. Only GET requests receive bounded automatic retries; non-GET requests have no automatic replay under S01, because they may have been committed before a network failure.
8. **LanceDB partial-batch handling:** Invalid vectors now reject the entire batch before the backend is opened, instead of silently skipping invalid records. Legacy HTTP insertion remains denied pending S04 durable write contracts.
9. **Version and health disclosure:** `package.json`, runtime `info.version` and plugin health now identify the S01 checkpoint. Health advertises `legacyMutations: BLOCKED`, `productionCertified:false`.
10. **Regression suite:** Added dependency-isolated Node tests under `tests/s01-safety.test.mjs`, runnable with `npm run test:s01`.

## Deliberately not performed

- No extension changes, write activation, data migration, collection-ID renaming, or physical database modifications.
- No claim of live backend compatibility or runtime certification.
- No replacement of the old plugin's read-authorization model, physical ID model, process-global configuration, Qdrant namespace parsing, complete inventory, or verified mutations. Those are S02–S10 work.

## Immediate functional impact

This S01 package is a **development safety checkpoint**, not a drop-in upgrade for an installation that depends on legacy plugin write routes. Plugin insert, edit, delete and purge are **temporarily blocked for Standard/Vectra, LanceDB, Qdrant and Milvus**. Health, connection, embedding, read/query/list and statistics routes remain present, subject to existing known backend and ownership limitations. Nothing has been unlocked.

## API denial example

```json
{
  "success": false,
  "code": "S01_MUTATION_BLOCKED",
  "error": "Legacy mutation route disabled pending safe identity, authorization and readback contracts.",
  "retryable": false,
  "checkpoint": "S01"
}
```

## Next checkpoint: S02

Implement a canonical server-side collection/record identity model, stable physical IDs and explicit migration mapping. Follow with S03 server-authoritative access scope, then S04 verified mutation operations; do not remove S01 mutation guards before those requirements pass.
