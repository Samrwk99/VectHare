# S06 — Qdrant v2 adapter checkpoint

**Base:** Cumulative S05 ZIP. **Plugin version:** `3.2.6-s06.0`.

## Implemented

1. `lib/s06-qdrant.js`: internal Qdrant v2 adapter built around S02 physical UUID record IDs, S03/S05 canonical scopes and S04 mutation plans. It provides scoped get/list/query via S05 and scoped insert/update/metadata/delete with independent post-write readback, **only for expressly marked disposable test transports**. Not registered as public HTTP routes.
2. Read-only physical schema inspection checks vector size and distance; refuses missing, incompatible and named-vector schemas without a purge/drop/recreate.
3. Explicit disposable-only collection provisioner creates a new collection of the expected vector dimensions, requests keyword indices for identity columns, then verifies schema. It refuses existing collections and does no automatic cleanup on partial failures.
4. Deletion uses a Qdrant filter containing `userScopeId`, `collectionId`, `type`, `sourceId`, `branchId`, `recordId`, `physicalId` and `revision` instead of bare hash IDs.
5. Updates keep the same point UUID and increment revision. Before modifying data the adapter validates operation scope, expected revision, vectors, text and metadata fingerprints; after each mutation it independently reads the exact scoped record.
6. Unbranched records now use an explicit empty-string `branchId` payload (rather than the previous `is_empty` filter) and S05 ownership verification accepts that normalization. This is a **new v2-only schema rule**; no legacy collection is migrated automatically.
7. S05 Qdrant response parsing now detects a mismatch between the physical point ID and a purported payload physical ID. Existing test was updated to expect the stricter mismatch error.
8. New `tests/s06-qdrant.test.mjs` exercises schema refusal, scoped filters, insert/edit/metadata/delete, branch isolation, forged plans, stale revisions, unreadable results, partial acknowledgements, disposable provisioning and isolated integration with the S04 operation ledger.

## Safety restrictions preserved

- **No public v2 Qdrant reads or writes enabled.** The route blockers from S01–S05 are unchanged. Legacy mutation endpoints remain `409`.
- Internal mutation methods refuse ordinary backend instances unless the caller explicitly marks a disposable test fixture. This flag is a developer test boundary, **not production authorization**, and must never be accepted from HTTP or ordinary configuration.
- Host source/chat/branch authorization remains unproven. S02 registry reservations are not ownership grants.
- Qdrant upsert is not an atomic revision compare-and-swap; the preflight check + upsert is **not safe under uncoordinated multi-writer or foreign plugin writes**. Production update and insert activation are blocked pending a proven exclusive writer/consistency policy.
- Qdrant may normalize cosine vectors and store float32 values, making a SHA-256 digest of the JSON representation of the submitted vector different from its actual readback. S04/S05 currently use exact vector fingerprints. A verified backend-appropriate vector comparison/fingerprint contract is required before production writes can be certified.
- Mocked transport behavior cannot establish genuine Qdrant SDK/API version support, backend index consistency, restart durability or search/pagination guarantees.
- `provisionDisposableQdrantV2Collection` must be used **only for isolated disposable fixtures**; partial creation/index failures are uncertain and the function never deletes collections automatically.
- S09 legacy migration, S11 host/VectHare integration and Qdrant live acceptance are still outstanding.

## Source API references used to validate proposed wire shapes

- Qdrant point deletion by filter: https://api.qdrant.tech/api-reference/points/delete-points
- Qdrant collection creation: https://api.qdrant.tech/v-1-19-x/api-reference/collections/create-collection
- Qdrant payload indexing: https://github.com/qdrant/docs/blob/master/qdrant/v1.2.x/payload.md

No external backend was contacted by the implementation tests.
