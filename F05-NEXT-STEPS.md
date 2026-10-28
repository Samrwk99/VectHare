# F05 Handoff — Qdrant actual full-functionality promotion

F04 connected one server-authorized, explicitly consented local-Qdrant **manual pilot**, not the normal VectHare memory pipeline. Complete these in order:

1. Run the F03 provision and full F04 pilot create → read → update → metadata → delete → restart sequence on the user's actual Termux Qdrant, with a fresh expendable chat and collection. Capture anonymized operation receipt states and actual physical readback.
2. Establish an enforceable Qdrant single-writer deployment policy or independently proven atomic conditional mutation semantics. Test competing external writers and multi-process/multiple-data-root races; do not treat local filesystem lock as global Qdrant CAS.
3. Verify fault cases before and after backend commit, interrupted ledger persistence, idempotent operation-status inspection and safe explicit reconciliation after restart with original vector evidence. Never auto-resubmit UNCERTAIN.
4. Complete source-scoped v2 production routes, call S04 engine using verified F01/F02/F03 scope, durable IDs and revisions; make write operations backend/operation-specific and fail closed. Provide redacted REST outcomes for the GUI.
5. Wire real VectHare GUI/manual inserts, automatic vectorization, reindexing, summaries, World Info and deletion to **v2 record IDs**, not legacy `/chunks/*`. Verify actual embedding generation via host-managed provider credentials and the final prompt injection path.
6. Preserve legacy vectors in quarantine until a separately verified, reversible migration exists. Do not guess chat branches or bulk-delete old collections.
7. Repeat identical end-to-end acceptance for two users, independent branches (including copied chat integrity IDs), restart, missing/deleted source, large inventory and exhaustive error paths.
8. Only after this, promote individual Qdrant capabilities in the server and E02 client matrix. Then undertake LanceDB/Similharity Vectra, native Standard and Milvus (F06–F08); F09–F12 cover all user workflows, exports and release.
