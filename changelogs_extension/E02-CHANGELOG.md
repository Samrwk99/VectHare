# VectHare E02 — Central Safety Enforcement and Backend Routing

Date: 2026-10-28. Baseline: **E01 Cumulative Capability Audit Checkpoint**. The Similharity plugin was **not modified**.

## Implemented

1. **Shared plugin/native vector request gate** (`utils/e02-vector-request-gateway.js`): route, HTTP method, backend and read/write intent are classified before the request is dispatched. Unknown endpoints/backends are rejected, and denied/unprobed operations throw a typed `VectorOperationDenied` error carrying operation, backend, transport and reason. No blocked request reaches the transport.
2. **Data-driven backend permissions** (`utils/e02-matrix-status.js`): deterministic runtime snapshot of all **80 E01 backend × operation cells**. No previously unproven mutation was promoted. Runtime overrides also deny Milvus point lookup because the plugin doesn't return independently verifiable tenant owner fields.
3. **Transport integration**: 12 production modules now import `guardedVectorFetch as fetch` instead of using the ambient browser fetch for all requests. This covers adapters for all four backends; Standard's native `/api/vector/*` path; diagnostics; direct collection import/export; collection discovery; reranking; database browser; and extension startup. Read-only C14 embedding and C05 credential probes route through the same policy. Non-vector fetch requests pass through unchanged.
4. **Qdrant tenant request correction** (`backends/qdrant.js`): the previously ignored top-level `filter` with `content_type` is replaced by the plugin's `filters:{type,sourceId}` on the list, query and hybrid query paths. Scoped GET sends JSON-encoded `filters` query parameter. Unrecognised/ambiguous logical identifiers are rejected instead of being silently treated as a chat. Results from Qdrant list/query/hybrid/point-get have their returned owner fields compared against the requested tenant. This improves isolation for reads **but does not certify the shared backend or permit writes**.
5. **Native Standard separation**: mutating `/api/vector/insert`, `/api/vector/delete`, and `/api/vector/purge` are explicitly denied because they are a separate, unprobed contract; non-mutating native list/query routes are still accessible subject to existing adapter validation.
6. **Credential forwarding defense**: nonempty `apiKey`, `token`, `password` or `authorization` fields in backend-init request bodies are refused before transport. The old plugin still lacks protected server-side secret resolution.
7. **Static enforcement check** (`tools/e02-verify.mjs`): all 98 E01 route edges across 15 relevant source modules must be explicitly gated, including known injected request paths. A new production module containing a literal direct plugin/native vector fetch route without the E02 import fails the check.
8. **Historical audit preservation**: the files E01 fingerprinted are retained under `docs/e01/source-baseline/`; `tools/e01-verify.mjs` validates the original bytes, not post-E01 source files. This keeps the E01 evidence intact and the historic audit repeatable as the code evolves.
9. **Regression updates**: legacy VM test loaders now accept the new transport import while still using their local fake fetch functions. Qdrant tests use explicitly qualified tenant IDs and matching ownership payloads, rather than permitting ambiguous identifiers.

## Result and limits

- **910/910 Node regression tests passed**, including **43 new E02 tests** (43 new test cases; all use fakes and make no live requests).
- E01 historical audit verified: 4 backends, 80 cells, 98 call edges, 89 source sites, 48 evidence refs.
- E02 static scan passed: 98 E01 edges; 15 files; 12 gateway-aliased modules.
- JavaScript syntax checks passed. ZIP integrity and SHA-256 manifest included with the release.
- **No real SillyTavern, Qdrant, Milvus, LanceDB or Vectra write test was run**.
- **No new mutations are unlocked**. Presently every plugin mutation in the matrix is `DENIED` or `UNPROBED`; native Standard mutations are unprobed/denied. This can prevent normal vectorization and editing, even where the earlier build attempted them. This checkpoint is a safety build, **not a certified feature-complete release**.
- The plugin's backend singleton configuration, dimension-triggered destructive behavior, hash collisions, swallowed errors, inventory incompleteness and lack of credential vault are *not solved* by this extension-only work.

## Follow-ups

**E03**: durable settings/journal readback and recovery; host persistence contract; multiple tabs. **E04**: read-only host integration, prompt receipts and retrieval. **E05**: disposable Standard/LanceDB contract probes, then selective write enablement. **E06**: Qdrant/Milvus compatibility assessment; any server patch must be separately approved. **E07**: real browser/backend acceptance.
