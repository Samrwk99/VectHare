# F02 — Authenticated Public v2 Read Integration

**Checkpoint:** F02, 28 October 2026. **Baseline:** F01 matched Similharity + VectHare. **Scope:** guarded, source-bound read execution; NO mutation activation.

## Plugin changes

1. New `lib/f02-public-reads.js` handles `/v2/reads/bind`, plus public scoped `get`, `list`, and `query` via the existing `lib/s05-routes.js` registration. Binding reserves only an S02 identity mapping; it **does not create or attest a physical database collection**.
2. For every `get`/`list`/`query`, re-check F01 ownership against a freshly inspected saved chat/branch/group/lorebook file. Derive `scope` solely on the server; reject browser-supplied user/owner, collection, physical ID, arbitrary source identity and credentials.
3. Require the matching persisted S02 mapping, exact v2 physical collection name, and backend v2 schema inspection before dispatch. Route to S06 Qdrant, S07 Milvus, S08 LanceDB or S08 Vectra adapters. Vectra still requires a separately verified v2 index seal; a reservation by itself cannot supply that seal.
4. Backend filters and returned top-level ownership are validated by the existing S05–S08 adapters. Errors retain stable codes, and the HTTP response does not leak backend error messages.
5. Ordinary page reads are **non-authoritative for full inventory**. `/v2/reads/inventory` remains denied. All legacy writes, all public v2 mutations, `purgeAll`, migration/cutover and verified exports remain denied.
6. Updated v2 contracts and capability reporting to distinguish **available guarded route** from globally enabled/certified read functionality; bumped plugin to `3.2.10-s10.6-f02` with a rebuilt source fingerprint.

## Extension changes

1. Added narrow, request-shape-validated F02 exceptions to the central E02 gateway for `/v2/reads/bind|get|list|query`. Other v2 execution routes and all mutation requests remain blocked.
2. Added `utils/f02-public-read-client.js`, a same-origin authenticated read client with strict refusal of falsely claimed export/write/ownership guarantees.
3. Added an F02 diagnostics panel to the SillyTavern settings GUI: select backend and exact embedding contract, reserve a source-bound mapping, list a bounded page, get a UUID record, or query using a diagnostic numeric vector. This is **not** the main automatic-memory retrieval workflow.
4. Updated the plugin compatibility pin and displayed state. Bumped extension to `2.2.0-alpha.s11.7-f02`.

## Known functional limitations

- Legacy Qdrant/Milvus/other collections are **not migrated or adopted**. Physical v2 collections must already exist with correct schema and authoritative ownership fields; the public read endpoints will clearly refuse a missing collection.
- No auto-provisioning of production v2 collections. No write reactivation. S08 Vectra index seals and LanceDB Arrow schema remain backend-specific prerequisites.
- F01 establishes ownership of an existing **saved file**, not the server's currently active browser chat and not ownership of legacy vectors.
- Vector query inputs are already-computed vectors; ordinary embedding/query orchestration and prompt injection remain for F03/F04/F09.
- Real Termux/Windows/Linux SillyTavern and actual Qdrant/Milvus/LanceDB/Vectra services remain untested in this environment. Offline tests are not live acceptance evidence.
