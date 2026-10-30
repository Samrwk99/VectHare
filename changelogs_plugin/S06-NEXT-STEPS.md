# S07 handoff — Milvus adapter and remaining acceptance gates

1. Start S07 from the **S06 cumulative ZIP**. Keep S01–S06 public mutation and unverified read routes blocked.
2. Implement Milvus v2 physical schema and stable tenant-qualified primary keys; inspect existing schemas before any change and never drop on mismatch.
3. Implement source- and branch-scoped get/list/search/delete with physical owner columns in projections. Do not let legacy hash-only get/delete bypass scope.
4. Match S04 mutation plans and S05 owned-record checks using an internal disposable-only test adapter. Preserve correct error vs empty-result semantics and independent readback.
5. Use Milvus SDK features verified for the deployed version. Do not promise stable inventory from ordinary offset pagination or unverified counts.
6. Test same text/hash across user A/B, chat branches A/B, missing/forged owner, repeated mutations, revision conflict, failed delete, dimension mismatch, restart and 1,050+ record traversal.
7. **Carry forward S06 blockers:** host-verified ownership/source grant, Qdrant multi-writer atomic revision problem, cosine/float32 readback fingerprint canonicalization, real Qdrant API/version acceptance, real Qdrant scroll/search and server restart evidence. These are not resolved by S07.
8. Keep S09 migration and S11 VectHare integration separate. A new source schema does not authorize blind conversion of legacy physical collections.
9. For every backend, report `PASS/FAIL/BLOCKED/UNPROBED` by operation and keep runtime matrix permissions denied until real-host/backend tests succeed.
