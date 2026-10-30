# Future Similharity safety update — proposal only

**Do not apply now.** This is a source-backed starting point for a separately approved plugin change and migration plan. Similharity source referenced by index.js SHA `32a2aba3a83511a61c34620c600db5a91c04b4d638c02919a4d0bf7217a5a287`.

## Critical server corrections

1. Qdrant `insertVectors`: dimension mismatch must raise a typed error, NEVER call `purgeAll`. Milvus `ensureCollection`: reject dimension or schema mismatch, NEVER call `dropCollection` on a normal write.
2. Qdrant and Milvus insert IDs must be globally unique across tenants; design a migration preserving old IDs, existing linked references and rollback, rather than silently switching hashes. Qdrant `_parseCollectionName` must not truncate colon-qualified names into ambiguous physical collections.
3. Qdrant handler `purge` must not call unscoped `purgeAll` with ignored filters; require explicit valid `type` and `sourceId` and use the scoped operation. Milvus `purgeCollection` must refuse empty filters and throw on errors.
4. Qdrant/Milvus `deleteVectors` must use tenant+ID criteria, propagate failures, return trustworthy mutations, and support independent readback.
5. Do not catch query/list/point-read backend exceptions and return empty results. Return errors distinctly from genuine absence. Milvus list needs stable pagination and actual total; Qdrant list needs bounded pagination that propagates scroll errors.
6. Milvus `queryCollection`, `listItems`, hybrid and get must return authoritative `type` and `sourceId` columns and use tenant filters (point get currently ignores them). Client metadata alone is not proof of physical tenancy.
7. Eliminate process-global Qdrant/Milvus per-user configuration and LanceDB's first-user storage path behavior. Resolve credentials in protected server-side per-user context, not the browser.
8. Add a stable, server-attested capabilities endpoint with exact deployed plugin source/build fingerprint and independent testable operation contracts. Expose typed errors, stable physical collection identity, authoritative scoped counts, readback and idempotent mutation semantics.

## Required release process

The plugin patch must be tested on disposable backend installations, including dimension mismatch, same physical hash in distinct tenants, failed delete/purge, restart recovery, multi-user separation and >1,000-record pagination. Perform a documented migration dry run, backup, verified execution and rollback. Only then revise the E02/E06 capability matrix; do not flip all permissions based on a version string.
