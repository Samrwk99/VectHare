# E06 — Qdrant/Milvus compatibility and shared-read hardening

28 October 2026. Based on the E05 cumulative extension and the separately supplied Similharity source. **Plugin source untouched; no mutating backend capability unlocked.**

## Runtime changes

- Added `utils/e06-shared-read-contract.js` for strict tenant-ID parsing, record-level ownership checks, an explicit unverified-inventory error, nonauthoritative display-page tagging, and empty-query status labeling.
- Qdrant: refactored its tenant-filter ID parsing through a single strict helper; retained scoped query result checks; marked display list results nonauthoritative, so downstream code receives `complete: false`, `verifiedInventory: false`; `getSavedHashes` now refuses to assert a complete shared collection inventory. Query responses include advisory `readVerification` and `inventoryComplete: false`.
- Milvus: removed the raw-ID-to-chat fallback, now rejecting ambiguous collections instead of guessing owner; added ownership validation for individual, multi-collection, and hybrid retrieval; validated display list ownership; refused authoritative saved-hash enumeration. Records with missing `metadata.type`/`metadata.sourceId` are rejected rather than assumed owned.
- Clarified Qdrant/Milvus adapter comments that plugin ownership and physical isolation are not guaranteed. Existing E02 matrix continues to deny all unsafe shared-backend mutations.

## New test/diagnostic work

- Added 54 E06 tests for tenant parsing, route mismatch, owner mismatch, unverified inventories, zero fetches for denied mutations, and read-only localhost-only diagnostic probes.
- Added `tools/e06-read-probe.mjs`: manual localhost-only, disposable-only, **nonmutating** health/list diagnostic. It stores neither retrieved text nor vectors and never claims certification, even on apparent success. Browser authentication/CSRF can cause it to fail; do not add credentials to work around restrictions.
- Added `tools/e06-verify.mjs`, source-backed `E06-CAPABILITY-ASSESSMENT.json`, acceptance checklist, future plugin-patch specification and runbook.
- Updated historical isolated-VM test harnesses to inject the newly imported shared-read helper; updated obsolete expectations that had treated unverified hash inventories or unqualified Milvus tenants as safe.

## Compatibility findings

- Qdrant `_parseCollectionName` removes namespace components for colon-qualified names. The extension's `qdrant_multitenancy: false` setting is **not** a server-side proof of collection-per-tenant isolation. Existing data naming cannot be migrated blindly.
- Milvus backend `queryCollection` and `listItems` fetch only `hash`, `text`, `metadata`; authoritative `type`/`sourceId` columns are omitted from result projections. Ordinary records may lack enough returned owner information, so E06 will reject those reads even when the server applied a tenant filter.
- Both shared backends can turn backend failures into `[]`, so zero rows do not prove that a tenant has no data. Qdrant/Milvus cannot provide deletion/export completeness guarantees on this plugin revision.

## Not achieved

- No Qdrant/Milvus insert/delete/update/purge activation.
- No guaranteed owner authenticity for user-controlled metadata.
- No deployed plugin hash attestation, disposable live probes, server restart testing, real host integration or production certificate.
- E05 Standard/LanceDB write activation still awaits separate real-backend evidence.
