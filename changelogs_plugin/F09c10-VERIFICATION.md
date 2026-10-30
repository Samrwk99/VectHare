# F09c.10 — Verification

- Similharity `3.2.10-s10.35-f09c10`: **496/496 tests passed** in clean combined Node test run (includes new F09c.10 runtime lock tests, F03 integration and inherited F09c.5 cross-process tests).
- VectHare `2.2.0-alpha.s11.36-f09c10`: **1,169/1,169 assertions passed** in clean combined test run.
- JavaScript syntax checks: all 120 plugin + 259 extension `.js`/`.mjs` files passed `node --check`.
- Plugin source manifest `4e75319f79d32930b2d9d3f169011fab342b32c44a0a0ffd1db808248bb9e8cc` matches source and the extension's S11 plugin version/hash pin. This is local code identity, not deployed host certification.
- F09c.10 local integration: four S04 backend mock adapters acquire writer gate; two separate Node processes cannot enter concurrently; killing an in-flight child retains lock; stale pre-dispatch failures release; UNCERTAIN readbacks retain; F03 provisioning shares the physical lock; untrusted root/scope refused.
- Backend SDK, real physical Qdrant/LanceDB/Vectra/Milvus CRUD, Termux/SillyTavern deployment, independent host restarts and actual backend concurrency have **not** been verified.
- Real-host acceptance for all four backends and final capability-matrix certification remain **OUTSTANDING**. No production writes were enabled; no purge/automatic cleanup/replay added.
- **Result: F09c.10 offline code integration COMPLETE; overall F09c OPEN; production NO GO.**
