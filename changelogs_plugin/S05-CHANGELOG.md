# S05 — Read, Inventory and Embedding Contract Foundation

**Date:** 28 October 2026  
**Source:** S04 cumulative plugin ZIP (v3.2.4-s04.0)  
**Version:** 3.2.5-s05.0  
**Status:** Offline implementation only. No real backend/live-host acceptance. No write or shared-read unlock.

## Actual code changes

1. **`lib/s05-contract.js` (new):** Strict canonical owner/embedding/record validation; physical-ID derivation check; text/vector/metadata fingerprints; finite numeric vectors with exact dimension; bounded page options; fail-closed malformed page and duplicate detection; bounded multi-page traversal. An entire traversal is explicitly **not** certified as a consistent snapshot. `verifiedExportAllowed` is always `false` absent separately established consistency.
2. **`lib/s05-backend-reads.js` (new):** Mock-testable, internal-only **new-v2-schema** Qdrant and Milvus read adapters for `getRecord`, `query`, `listPage`. Every query uses server-attested scope fields, including branchId; every returned record must carry authoritative top-level ownership fields, a canonical physical ID, revision and fingerprints. Errors propagate; only confirmed zero matches return null/empty. Qdrant exposes a native scroll cursor rather than loading the entire physical collection. Milvus uses bounded offset pagination **without** asserting snapshot consistency. New schema and API behavior require real backend verification.
3. **`lib/s05-routes.js` (new):** Authenticated `POST /v2/reads/preflight` validates shape, embedding and page bounds but never authorizes access. Public `/v2/reads/get|list|query|inventory` explicitly return 409, including when caller supplies forged attestation fields. This prevents bypass of S03's legacy Qdrant/Milvus read restrictions.
4. **`index.js`:** Registers S05 gates; validates vectors returned by existing embedding endpoints; requires uniform batch vector dimensions/size; validates finite search vectors and bounded topK/threshold before legacy query dispatch. Backend/provider/model correctness still awaits actual host testing.
5. **Tests:** `tests/s05-contract.test.mjs`, `tests/s05-backend.test.mjs`, `tests/s05-route.test.mjs`. Existing VM-mocked index test import maps are extended for new modules; the original expectations remain unchanged.
6. **`package.json`:** Version and S05 cumulative test/syntax scripts.

## Deliberately *not* implemented/activated

- Source ownership attestation for chats, lorebooks, scenes and branches: S03 authenticated user identity alone is insufficient. Client-provided scope is **not** authority.
- New v2 record storage schema, live backend changes, production-backed S04 `getRecord`/mutations, or public v2 reads.
- Authoritative complete inventory under concurrent writes; stable Milvus pagination beyond a limited page; verified export/migration.
- Native Standard or LanceDB v2 read adapters; these are S08 dependencies.
- Legacy shared-backend read reactivation, S01 legacy mutation unblocking, or new writes.

## Compatibility and safety

Existing protected `/chunks/*` routes retain prior S01/S03 behavior. S05 adds stricter rejection of malformed vectors and invalid query parameters, so inputs previously tolerated may now fail. Internal v2 adapters assume **new physical records** with stable UUID IDs, canonical `userScopeId/collectionId/type/sourceId/branchId`, versioned embedding, revision, and content/vector/metadata fingerprints. Legacy Qdrant/Milvus objects lack some of those fields and **must not** be silently upgraded or treated as verified owner records.

The supplied S04 operations/ledger code is untouched except for test harness imports. No real Qdrant/Milvus requests were executed.
