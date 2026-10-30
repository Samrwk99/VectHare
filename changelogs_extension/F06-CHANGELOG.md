# F06 — LanceDB source-bound development integration

**Baseline:** VectHare F05 extension / Similharity F05 plugin. All F01–F05 code retained.

## Implemented

1. Fixed F02 LanceDB public read route to select the database for the verified embedding source (`getDatabase(binding.embedding.source)`), never the legacy `backend.db` getter, which can refer to a different source or be null.
2. Added explicit schema-first, **non-overwriting** LanceDB v2 collection provisioning via the F03 source attestation, binding, collection lock, confirmation and durable receipt. The new table has 16 columns and a fixed-size float32 Arrow vector field. `createEmptyTable` uses `mode: create, existOk: false` and refuses preexisting names. Added the required Apache Arrow dependency.
3. Extended the GUI F03 preview/provision/status control to LanceDB. No manual file or JSON configuration is needed for normal local LanceDB selection, subject to the host supporting the LanceDB native module.
4. Added F06 disposable LanceDB lifecycle diagnostic (server-generated isolated table, synthetic vector and ID, create/read/search/metadata/stale-revision/page/reopen/delete/readback; never drop). GUI action accepts only fixed consent and cannot choose a path or physical table.
5. Added **source-bound LanceDB manual mutation PILOT**, reachable only through the GUI. Its authenticated route re-attests F01 ownership for every operation, requires an F03 completed provisioning receipt, inspects the actual v2 table, and uses S04 immutable plans, collection/record locks, durable UUID ledger and S08 v2 adapter with scoped reads/writes. Insert/update/metadata/delete and receipt inspection are opt-in. This is not automatic chat vectorization or production mutation activation.
6. Updated v2 capability declarations and exact S11 build-fingerprint compatibility pin, while preserving the E02 legacy write blocks, public v2 production-deny routes and verified-export denial.
7. Added regression tests for source selection, schema and create-only policy, disposable lifecycle, pilot CRUD/replay/stale revision, user/branch scope, F03 receipts, fixed browser request shapes and false success claims.

## Known issues / limits

- No real `@lancedb/lancedb` native module or Apache Arrow-backed test was run in this environment. Test doubles replicate expected SDK interfaces; host SDK APIs, update acknowledgements, schema behavior and Termux native compatibility are **unproven**.
- The F06 diagnostic creates a real isolated table when run on an installed host. A failed test can leave synthetic rows, and its fresh adapter test is **not** an independent process/SillyTavern restart.
- External SDK clients can bypass filesystem locks. Concurrent independent writers and crash recovery are unproven. Never expose these operations as production-ready.
- Ordinary VectHare chat memory insertion/retrieval, summary and World Info CRUD, legacy migration, verified inventory/export, native Standard/Vectra and Milvus completion remain gated. F05 Qdrant full activation is also still incomplete.
- LanceDB's native libraries may not have binaries for all platforms/architectures, especially Termux; this must be checked during host acceptance rather than inferred from Node portability.
