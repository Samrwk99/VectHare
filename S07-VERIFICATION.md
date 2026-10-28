# S07 — Verification report

**Checkpoint:** Similharity 3.2.7-s07.0  
**Source baseline:** `VectHare-Similharity-S06-Qdrant-Backend-Completion.zip`  
**Result:** OFFLINE_IMPLEMENTED_ONLY; NOT LIVE CERTIFIED; NO PUBLIC READS/WRITES UNLOCKED.  
**VectHare modified:** NO.

## Local test evidence

- Cumulative Node tests: **164/164 PASS**, **0 FAIL** (`npm run test:s07`).
- JavaScript/ESM syntax checks: **33/33 PASS** (`npm run check:s07`).
- New S07 tests: **22**; retained 142 previous test cases.
- Execution uses in-memory Milvus SDK-shaped mocks plus temporary local S04 operation-ledger files. No real network or Milvus instance was used.
- Normal public adapter construction rejects mutation before backend network dispatch; S01 legacy route denials are preserved.
- Disposable-only test transport executes scope-qualified insert, metadata and text upsert, and conditional delete with independent readback.
- Error status, missing/malformed return values, missing owner fields, stale revisions, invalid physical IDs, mismatched dimensions and index metrics are rejected in tests.
- Bounded 1,090-record traversal was executed; it is explicitly **NOT** a stable snapshot/verified inventory proof.

## Capability acceptance

| Operation | Implementation / test evidence | Live certification |
|---|---|---|
| Read-only physical schema + index inspect | Internal; mocked, fail-closed | UNPROBED |
| New disposable v2 collection provisioning | Internal fixture only; mocked | UNPROBED; not public |
| Scoped get/list/query | S05 reads + S07 status/strong consistency; mocked | UNPROBED; not public |
| Insert with independent readback | Internal fixture tests | BLOCKED |
| Update text/metadata + revision check | Internal fixture tests | BLOCKED — Milvus upsert lacks cross-writer CAS |
| Targeted scoped delete + readback | Internal fixture tests | BLOCKED |
| Full consistent inventory/export | Only bounded traversal | BLOCKED |
| Hybrid search | Not implemented in v2 adapter | BLOCKED |
| Migration of existing schema/hash IDs | S02 read-only planner only | BLOCKED |

## Outstanding evidence

1. Actual SillyTavern user and chat/lore/branch ownership attestation.
2. A deployed Milvus 2.6.x instance and exact installed SDK version/hash.
3. Actual fixed-schema collection creation, index metrics and strong-consistency behavior.
4. Actual float32/vector and JSON roundtrip fingerprints, including unusual vector values and metadata.
5. Real two-user/branch isolation, external writers and concurrent update/delete conflict handling.
6. Server/browser crash, uncertain response and restart reconciliation tests twice.
7. Stable inventory strategy under concurrent writers and complete export integrity.
8. S09 data migration, S11 VectHare integration and end-to-end final outgoing prompt checks.

**Release decision: all public mutations denied, all new v2 public reads denied.** Do not deploy as a replacement for valuable working installation until live evidence and migration plan exist.
