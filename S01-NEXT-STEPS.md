# S01 handoff / S02 entry

1. Preserve both input ZIPs and this S01 ZIP. Keep the extension at E06 (unchanged).
2. Define the canonical record and collection identity schema, including server-side trusted user, logical chat/lorebook/branch/source, stable recordId, contentHash and physicalId. Record both legacy and new identity mappings.
3. Fix Qdrant lossy `_parseCollectionName` and LanceDB sanitized table collisions using a verified, durable map; do not rename existing physical collections implicitly.
4. Design migration manifests, backups, ambiguous-record refusal and rollback before changing existing hash point IDs.
5. Implement S03 authorization and per-user connection isolation before enabling shared mutations.
6. Introduce S04 server-authoritative insert/update/delete with verified readback, operation IDs, revision checks and recovery. Only then replace the S01 refusing route handlers by individual accepted v2 operations.
7. Independently test each backend on a disposable running host and update the operation-by-operation capability matrix. Never blanket-enable writes.
8. Handle SillyTavern **chat branch UUID/fork detection in VectHare**, not just in the plugin: S02 can enforce different server scopes but cannot infer host branch creation by itself.

**Known gaps intentionally retained:** shared read authorization, Milvus get tenant filtering/projection, Qdrant name parsing, backend singleton configuration, LanceDB first-user path, verified inventory/pagination, hybrid parity, actual SillyTavern integration.
