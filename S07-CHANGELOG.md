# S07 — Milvus v2 backend safety and contract checkpoint

**Baseline:** `VectHare-Similharity-S06-Qdrant-Backend-Completion.zip`  
**Plugin version:** `3.2.7-s07.0`  
**Scope:** Similharity only; VectHare is unchanged.  
**Status:** OFFLINE IMPLEMENTED / NOT LIVE CERTIFIED / NO CAPABILITIES REACTIVATED.

## Implementation

1. Added `lib/s07-milvus.js`, an **internal** Milvus 2.6-oriented v2 adapter. It consumes the existing S02 canonical physical collection and UUID point identities, S04 immutable mutation plans and ledger, and S05 ownership/read contracts. It is **not imported into public HTTP routes**.
2. Read-only `inspectMilvusV2Collection()` checks all required scalar fields, one non-auto VarChar primary ID, FloatVector dimension, and the vector index metric. Incompatible or missing physical schema fails. No drop, alter, reindex or automatic creation occurs on inspection.
3. Added `milvusV2OwnerExpression()` using server-provided canonical owner scope (`userScopeId`, `collectionId`, `type`, `sourceId`, explicit `branchId`), with optional `recordId`, `physicalId` and `revision`; it validates physical/record binding and has no hash-only fallback.
4. Internal scoped `getRecord`, `listPage` and `query` build on S05 Milvus v2 readers and add transport-status enforcement and strong-consistency requests. Returned physical owner columns must match before data is used. Backend exceptions and non-success status are distinct from empty results.
5. Added disposable-fixture-only `insertRecord`, `updateRecord` (text and metadata) and `deleteRecord`, plus independent record readback. Every mutation checks the v2 collection schema and vector metric and requires an S04 plan bound to the exact collection, record, revision, hashes and embedding.
6. Milvus FloatVector receives only inputs already representable as Float32, so S04/S05 JSON-vector hashes are not silently compared against a different in-memory numeric representation. Float32/JSON serialization behavior, Milvus query visibility and index behavior **still require actual backend validation**.
7. Added `provisionDisposableMilvusV2Collection()`: refuses any existing collection; creates an explicit fixed-field v2 schema with non-auto UUID VarChar primary key, creates a vector AUTOINDEX and requests load. On uncertain/partial completion it refuses automatic cleanup or deletion.
8. `tests/s07-milvus.test.mjs` adds 22 offline cases: schema and index mismatch, complete owner filters, explicit branchless scope, text/metadata update and delete, multi-branch and multi-user isolation, forged identities, malformed vectors, mismatched ownership, invalid response status, failed/uncertain mutations, revision conflicts, >1,050 record bounded traversal, disposable provisioning, ledger reconciliation after simulated restart and public route refusal.
9. Updated package metadata and README; added `npm run test:s07` / `npm run check:s07`.

## Deliberately not enabled

- Public v2 Milvus **reads and writes**, including hybrid search and complete verified export.
- All legacy unsafe mutation endpoints blocked by S01.
- Physical drops, unscoped purge, automatic schema migration or implicit collection creation.
- Real multi-writer upsert/update authorization. Milvus upsert does **not** provide the required cross-writer atomic revision compare-and-swap; a pre-read plus upsert is not equivalent to CAS.
- Real source/chat/branch ownership attestation, actual Milvus network/SDK acceptance, backend restart and crash recovery.

## Additional limitations and follow-up

- The S05 `walkInventory` helper expects **raw backend rows**; it cannot simply consume an already-normalized `listPage()` result, because that would re-validate a different shape. S07 tests keep raw traversal and normalized page checks separate. This integration contract should be normalized before S11.
- Ordinary Milvus `offset` browsing remains unverified for consistent full inventory and has a bounded maximum. No verified export or scoped bulk purge is authorized by it.
- v2 `text` uses VarChar (65,535 bytes), narrower than the S04 generic 1 MiB text limit; the S07 adapter explicitly rejects oversized text. A unified schema/large-text strategy is future work if 1 MiB records are required.
- S02 scope identities are source-driven; independently proven chat-branch creation remains a VectHare/SillyTavern requirement.
- Legacy schema/IDs are not migrated; S09 remains necessary.

## External contract references (not live verification)

- https://milvus.io/api-reference/node/v2.6.x/Vector/deleteEntities.md
- https://milvus.io/api-reference/node/v2.6.x/Vector/upsert.md
- https://milvus.io/api-reference/node/v2.6.x/Management/describeIndex.md
- https://milvus.io/docs/create-collection.md
- https://milvus.io/docs/install-node.md

These published API shapes inform source implementation but do not constitute a successful test against a deployed Milvus server.
