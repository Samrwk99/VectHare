# F02 — Disposable SillyTavern Read Acceptance

Use the **matched F02 extension and plugin** in a disposable SillyTavern profile. Do not overwrite a valuable working plugin, old collections or memories. Preserve the original F01/S11.5 backups.

1. Install both matched F02 packages, install normal plugin dependencies if needed, restart SillyTavern and reload the browser. Confirm the plugin compatibility panel reports the F02 source-bound read contract. Set Qdrant/Milvus connection details through the VectHare GUI as already supported.
2. Create and save a disposable chat. In VectHare's F02 diagnostics area, select the backend and enter the **exact** embedding model, vector dimension and metric. These must match the v2 physical collection's schema; do not guess them. Choose **Bind saved chat**. Expect a `bindingReserved` response; this only reserves a logical name and does not create any vector database collection.
3. Choose **List v2 records**. If no matching v2 physical collection exists, expect a clear `S06_COLLECTION_MISSING`, `S08_COLLECTION_MISSING` or other schema/collection refusal, **not** an empty list, success claim or legacy fallback. This is currently the expected outcome on an ordinary unmigrated installation.
4. If a specifically preprovisioned *disposable v2 collection* exists with correctly scoped synthetic records, validate get/list/query. Inspect that two independently saved branched chats (even with identical integrity metadata) resolve to separate bindings and do not see each other's records. Test a different user profile; mismatching records must be rejected or filtered.
5. For each read, collect sanitized HTTP status and machine code, backend type, whether the source file was saved, and whether the physical v2 collection exists. Never paste private chats, embeddings containing sensitive text, server paths or credentials.
6. Try insert, update, delete, reindex and legacy Qdrant list/query: they should remain denied. Try `/v2/reads/inventory`: it must remain denied; a paginated list never proves a complete export.
7. Restart SillyTavern and check binding stability; repeat branch/ownership reads. No real-backend or final-prompt certification is claimed by an offline ZIP.

**F03 prerequisites:** real backend provisioner, model/float32 compatibility, concurrency and verified readback, then F04 authorized mutations. The next integration stage must update the ordinary memory/query pipeline without silently interpreting v2 UUIDs as legacy hash IDs.
