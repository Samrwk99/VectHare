# S09 — Verification report

**Build:** 3.2.9-s09.0 · **Baseline:** S08 · **Scope:** offline-only migration planning and disposable local-file rehearsal.

- Cumulative test suite: **210/210 PASS**, **0 FAIL** (`npm run test:s09`), including **23 new S09 tests** (S08 baseline 187).
- JavaScript syntax checks: **42/42 PASS** (`npm run check:s09`).
- S09 unit tests cover missing independent owner mappings, duplicate legacy IDs, branch differentiation, conflicting owner evidence references, target collisions, invalid hashes, dangling and cross-user references, transitive quarantine, manifest digest tampering and changes to source input.
- Isolated fixture tests cover explicit disposable opt-in, empty private destination requirements, symlink refusal, backup and v2 staged row readback, missing vector refusal, tamper refusal, retained backup after rehearsal rollback, and no public migration endpoint.
- CLI smoke with a synthetic one-record inventory: `s09-plan.mjs` returned a candidate manifest; `s09-fixture-rehearsal.mjs` staged and verified the fixture, with cutover explicitly prohibited.
- No plugin mutation gates altered, no VectHare modifications, and no actual user data or backend collections accessed.

## Not established

No backend-native complete or stable snapshot; no independent host ownership/branch authority; no existing-data inventory; no real Qdrant/Milvus/LanceDB/Vectra migration, backup, restore or cutover; no multi-process revision/CAS proof; no certified full export; no running SillyTavern integration. The `ownerMappings[].evidenceId` is an operator reference and NOT a server attestation. Fixture backup/stage verification is not production database proof.

**Release decision:** S09 offline migration/compatibility tooling implemented and tested. **Production migration and all public writes remain denied.**
