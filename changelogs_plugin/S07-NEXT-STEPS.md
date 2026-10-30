# S08 handoff — LanceDB and Standard/Vectra backend completion

1. Use the **cumulative S07 plugin ZIP** as baseline. Preserve S01–S07 public read/write gates; do not reactivate unsafe routes.
2. Implement the new S02/S04/S05 v2 record, scope, schema, readback and error contracts on LanceDB and plugin Vectra. Test their native storage behavior independently; native SillyTavern Standard routes are NOT automatically governed by the plugin.
3. For LanceDB, fix physical table-name collisions, per-user physical storage and caches, unsupported/ambiguous legacy names, invalid partial batch insertion, scoped get/delete and safe table management. Do not remove `.lance` directories during normal error handling.
4. For Standard/Vectra, explicitly verify insert/list/get/delete/readback, persistence on restart, duplicate IDs, complete inventory and native-vs-plugin endpoint differences.
5. Keep S04 operation plans and ledger internal until host-authenticated source grants, deployed backend contract and operation-specific live evidence exist.
6. Carry S06/Qdrant blockers: live upsert concurrency/CAS (or exclusive-writer protocol), float32/cosine vector normalization, real Qdrant acceptance, host source/branch rights, restart/fault tests.
7. Carry S07/Milvus blockers: real Milvus 2.6 SDK/server behavior, vector schema and index metric, float32 serialized readback, strong consistency under restart, upsert non-CAS, real multi-process writer isolation and authoritative source grants.
8. S05 inventory walker expects raw records; normalize walker/readPage shapes before production export, and do not certify full inventory from offset traversal alone.
9. S09 migration and S11 VectHare final integration remain separate. Do not infer ownership of legacy records from client metadata or silently switch physical IDs.
10. Required real acceptance for every proposed backend capability: isolated sourceA/sourceB and branchA/branchB, malformed/missing owner fields, same text/hash, >1,050 records, real backend errors, settings persistence, interruption and two runs separated by restart; record PASS/FAIL/BLOCKED/UNPROBED.
