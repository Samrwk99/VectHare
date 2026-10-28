# S10 handoff — API stabilization and plugin release candidate

1. Treat S09's manifest as an offline **candidate** only; it cannot be used to authorize production migration, source ownership or collection cutover. Keep S01 legacy mutation routes and public v2 reads/writes blocked.
2. Stabilize versioned public API shapes and server-attested capability reporting with exact deployed source/build fingerprints; reject unsafe old routes rather than silently proxying them.
3. Complete server-trusted chat/lorebook/scene/branch mapping and explicit authorization checks before any v2 record route can execute; don't infer source grants from arbitrary browser metadata.
4. Resolve S06 Qdrant and S07 Milvus multiwriter/CAS behavior and readback precision with actual backend instances; verify native pagination, snapshots and error propagation.
5. Validate S08 LanceDB/real Vectra SDK schema, vector serialization, transaction/locking, persistence and restart. Native SillyTavern Standard routes remain separately tested, not implied by the plugin.
6. Implement backend-native **disposable** migration adapters only after source/target schema, coherent snapshots and recovery can be proven. Verify backups/restores and ownership, preserve all legacy IDs and references; never silently cut over.
7. Address S09 quarantine, including colliding hashes, ambiguous user/branch IDs, cross-user references and hidden relationships inside VectHare metadata before any data copy/cutover.
8. Run authenticated real-host and backend acceptance, failure injection, two-user/branch isolation, >1,050-record inventories, interruption and restart tests. Distinguish offline source tests from live evidence.
9. Only after S10 and S11 acceptance should VectHare promote individually verified backend/operation policy cells and offer controlled migration/recovery UI.
