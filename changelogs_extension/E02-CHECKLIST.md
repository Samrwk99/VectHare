# E02 Acceptance Checklist

## Completed and verified locally
- [x] Starting point is the E01 cumulative extension, not a reconstructed feature subset.
- [x] All 4 plugin backend profiles and 20 operation categories are represented in the data-driven gate.
- [x] The 98 source-audited request edges, including diagnostics and native Standard vectors, are associated with the E02 gate.
- [x] Denied/unprobed writes make zero network calls, verified by automated tests.
- [x] `/chunks/purge`, `/purge-all`, and `PATCH /chunks/:hash/text` are prohibited for all plugin backends.
- [x] Shared-backend Qdrant/Milvus insert, delete and metadata updates are prohibited.
- [x] Native Standard insert/delete/purge are separately prohibited until proved.
- [x] Qdrant list/query/hybrid now use the actual `filters.type` / `filters.sourceId` plugin contract.
- [x] Qdrant result ownership is checked after list/query/hybrid/get.
- [x] Ambiguous Qdrant tenant IDs and missing/foreign owner fields fail closed.
- [x] Milvus single-chunk point reads are prohibited because the actual server response lacks owner fields.
- [x] No secret-bearing Qdrant/Milvus backend init body is permitted.
- [x] Non-vector network calls are not intercepted.
- [x] E01 original fingerprints remain auditable via historical source copies.
- [x] All existing and new automated regression tests pass (910/910).
- [x] All production JS syntax checks pass.
- [x] Similharity plugin source remains unchanged.

## Deliberately not claimed / pending
- [ ] Browser-level proof that every UI flow displays a usable refusal instead of a silent failure.
- [ ] Real SillyTavern host event, request, authentication and settings acceptance.
- [ ] Independent deployment-time plugin file-hash attestation (HTTP `/health` version isn't sufficient).
- [ ] Durable journal readback and cross-tab lock validation (E03).
- [ ] Authoritative scoped inventory / deletion / transaction proofs (E05–E07).
- [ ] Standard/LanceDB mutation activation (E05, after disposable probes only).
- [ ] Qdrant/Milvus shared-store write safety (server-dependent; no claim of resolution).
- [ ] Real-host Qdrant/Milvus scoped retrieval, including mixed-tenant and corrupt-record testing.
- [ ] Better user-facing degraded-state messages across every UI feature.
- [ ] Full production compatibility certification.

## Known usability impact
Until selective capability verification is complete, normal vector inserts/updates/deletes may be blocked on all four backends. This is intentional E02 default-deny behavior, **not a claim that the extension is ready for general use**. Do not deploy over valuable existing data as a drop-in replacement without acceptance testing.
