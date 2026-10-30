# P-B.4 — Owned Qdrant collection lifecycle in Database Browser

**Baseline:** VectHare P-B.3 + Similharity P-B.3, 30 October 2026.
**Matched release:** VectHare P-B.4 + Similharity 3.2.11-p-b.4.

## Implemented

- **P08 partial, functional Qdrant integration:** the Database Browser now displays a managed, source-bound Qdrant collection lifecycle workspace using the **existing, server-guarded M3 routes**. It supports owned collection inspection, private logical backup creation + independent integrity check, backed-up `empty`, `restore`, and `delete` plans, exact typed confirmation, one-use execution, and receipt reporting. It never takes a browser-supplied physical collection ID or raw vector contents. The obsolete purge button and legacy collection-deletion implementation are unchanged and cannot be used as v2 authority.
- **Lifecycle state checks:** change of chat/lorebook, configuration, collection generation, record count, inventory digest, or source fingerprint (when supplied) invalidates further planning. A missing or mismatched backup, integrity verification failure, or disabled plan cannot enable execute. Failed reinspection invalidates old proof. Executed plans are consumed before network dispatch: a timed-out or uncertain execution is never auto-replayed.
- **Deliberate scope:** M3's own server-side planning and execution remain the sole authority for target ownership, current generation, physical inventory, backup and write-lock decisions. The UI reports `VERIFIED` only for a validated M3 receipt, and explicitly directs a fresh reinspection rather than claiming a cross-tab physical proof. Only Qdrant is integrated in this P-B.4 workspace. LanceDB, Vectra and Milvus lifecycle actions are **not** certified by this addition; their managed-backend collection lifecycle and authoritative physical inventory remain open P-B work.
- **Other P-B tasks:** P07 direct saved-source text edit and summary integration, P14 revision-checked scene editing, P13/P16 other backend inventory, P22 registry/cache synchronization, P29 durable group membership repair are **not** completed in this release.
- Plugin runtime behavior is unchanged; matched version and S10 build-integrity manifest were updated. Matrix remains **32 enabled / 33 blocked / 5 unsupported**, obsolete purge untouched.

## Verification

- New P-B.4 unit tests cover proper M3 action routing, typed confirmation, one-shot execution, timeout/no-replay, source/config changes, collection-generation drift, foreign logical keys, denied plans, unsupported purge, failed fresh inspection.
- Existing M3 UI/integration tests and complete extension/plugin Node suites rerun in bounded batches. See `P-B4-TEST-RESULTS.md` for exact totals.
- Manual testing with a **disposable owned Qdrant collection** is required; destructive operations are not production certified. Real LanceDB/Vectra/Milvus lifecycle proof is not provided.
