# VectHare / Similharity P-A.5 — Repair/Provider/Diagnostics Compatibility Patch

Date: 30 October 2026. Matched extension `P-A.5` and plugin `3.2.11-p-a.5`.

## Corrections

1. **P02 extension gateway/provider mismatch:** the narrow `/v2/embeddings/profile` PUT gate now agrees with the plugin's supported local providers: llama.cpp, Ollama, vLLM and KoboldCpp. Only fixed loopback paths (`127.0.0.1:<port>/v1/embeddings`, or Ollama `/api/embed`) are accepted; browser-supplied vectors, physical collections, credentials-in-URLs and unrelated mutation operations remain forbidden. Automated tests cover all four providers and remote/incorrect endpoint refusal.
2. **P05 Repair cannot trust registry-only ACTIVE status:** normal Sync remains inventory-based, but Repair sends a server-scoped `verifyPhysical:true` flag for every source-bound preview page. The plugin reattests the saved source/binding, reads each `ACTIVE` record through its existing trusted physical read adapter, verifies record identity, revision, embedding provenance and ownership. Missing records are identified as `physicalState:MISSING` and counted for **review**, never blindly recreated. Physical read errors, ownership/schema exceptions or registry/physical contradictions abort rather than become a success. An unchanged ACTIVE row only counts as healthy when `physicalState:VERIFIED`. The signed pagination cursor also binds the physical-check setting to prevent downgrades between pages. The obsolete purge button is untouched.
3. **P19 legacy dimensions:** `checkQdrantDimensionMatch()` and `testVectorDimensions()` no longer send browser-defined `/get-embedding` or legacy shared collection-info/stats probes. They consume authenticated source-scoped managed M1 profile and preview evidence; where the managed service does not expose an independently validated **physical dimension comparison**, diagnostics explicitly return **warning / UNVERIFIED**, not PASS. Non-managed legacy backends also do not get a fabricated PASS. The separate production disposable storage-write fixture remains outstanding.
4. **P03 profile UI:** when an existing local-provider profile loads from the server, the endpoint input's disabled state now synchronizes with the restored provider immediately, without changing the provider dropdown manually.

## Automated evidence

* Plugin: **869 passed, 0 assertions failed** across 99 files in four bounded batches. A prior pre-manifest run reported 12 failures because its source manifest was stale; regenerated S10 manifest, reran the affected plugin batch with 269/269 passing, plus the route/source tests with 17/17 passing.
* Extension: **1,253 passed, 0 assertions failed** across 89 Node test files, using bounded batches plus isolated retries for the intermittent Node 22 VM `SIGSEGV` in unrelated metadata tests. One grouped run reported a `SIGSEGV` for that file; it passed independently (15/15) on retry. The baseline Vitest `*.test.js` suite was not executed without dependencies.
* New tests check four provider gateway cases; loopback-only rejection; Repair missing, verified and unverified records; physical read failure; page cursor flag pinning; no blind mutation; P19 no misleading PASS; saved-profile local endpoint enabled after asynchronous load.
* Plugin S10 source manifest regenerated for `3.2.11-p-a.5` (115 measured source files). Automated tests, fixture/adapter proofs and a local source manifest are **not** live database/provider/SillyTavern certification.

## Acceptance still outstanding

* Actual host with both packages installed, real provider on selected port, Qdrant/Milvus/LanceDB/Vectra readback, edited/swiped and physically deleted record Repair tests, prompt retrieval and interrupted/restarted large chats require user live acceptance.
* Physical dimension measurement remains `UNVERIFIED` unless a future server-managed schema/identity proof route supplies independent evidence. No fall-back to untrusted browser-generated embedding tests.
* P19 disposable managed storage-write test fixture still not implemented; diagnostic writes remain `SKIPPED / UNVERIFIED`.
* P04 full World Info conditions/linked retrieval remain later tasks, P06 real crash/recovery remains unverified. No claims of all P-A tasks being fully finished or production-certified.
* Capability matrix unchanged (**32 enabled / 33 blocked / 5 unsupported**). No obsolete purge-button modification or safety permission expansion.
