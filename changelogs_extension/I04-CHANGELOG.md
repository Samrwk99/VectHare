# I04 — Backend failure detection, error contracts and acknowledgements

**Base:** `VectHare-I03-Fixed.zip`. Cumulative ZIP retains I01–I03.

| Issue | Implemented correction | Main source |
|---|---|---|
| #105 | Manual Sync accumulates failed item attempts and reports an incomplete run rather than declaring success when any insertion fails. | `core/chat-vectorization.js` |
| #78 | LanceDB/Milvus multi-collection queries preserve HTTP, network and application-level errors in per-collection result metadata; healthy collections still return results. | `backends/lancedb.js`, `backends/milvus.js` |
| #109 | Retrieval records individual query failures; all-failed searches raise an error, while partial results show a warning and retain debug failure details. | `core/chat-vectorization.js` |
| #222 | Qdrant/LanceDB/Milvus saved-hash listings require a successful, well-formed payload with an explicit `items` array. | `backends/{qdrant,lancedb,milvus}.js`, `utils/backend-response-validation.js` |
| #66 | Standard native list no longer interprets HTTP 500 as an empty collection; malformed HTTP-200 payloads are rejected. | `backends/standard.js` |
| #223 | Standard backend health no longer treats HTTP 500 as healthy. | `backends/standard.js` |
| #67 | A rejected Similharity Standard-backend init marks the plugin unavailable and uses the existing native SillyTavern path rather than claiming plugin initialization succeeded. | `backends/standard.js` |
| #85 | Milvus hybrid-query errors are thrown; vector-only fallback is restricted to unavailable/unsupported endpoint statuses (404, 405, 501). | `backends/milvus.js` |
| #129 | Qdrant hybrid-query errors are thrown; vector-only fallback is restricted to unavailable/unsupported endpoint statuses (404, 405, 501). | `backends/qdrant.js` |

**Related hardening:** Qdrant/LanceDB/Milvus single-collection HTTP-200 query payloads now validate success and a result array. Error metadata is preserved across the core multi-query scoring layer. The I02 Qdrant test loader was updated to link the new validation utility.

## Verification

- `npm run test:i04`: **19/19 passed** (fake HTTP responses, two manual-vectorization completion paths, query failures, hybrid fallback).
- `npm run test:repair`: **50/50 passed** (all I01–I04 focused tests).
- `node --check`: all `.js` and `.mjs` syntax checks passed.
- ZIP integrity test passed.
- **Not run:** Live SillyTavern/Similharity integration tests; server-specific error payloads and exact unsupported-endpoint codes must be validated against the supported server versions.

## Remaining scope

- Phase 2 C06 will introduce a complete backend capability/response contract. This I04 implementation is local validation only, **not** an architectural C06 implementation.
- Retry safety, uncertain commits, and atomic recovery remain Phase 2 C02/C03.
- I04 does not solve other backend pagination, partial inventory or identity-scope issues.
