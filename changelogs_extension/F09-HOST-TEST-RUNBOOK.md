# F09 host test — guarded v2 memory retrieval preview

1. Back up your VectHare and Similharity folders. Use a **disposable** SillyTavern profile. Install BOTH F09 packages together and restart SillyTavern.
2. Confirm the compatibility status says **Similharity F09 detected**. If not, do not use the new endpoint; inspect the plugin's startup errors and the matching versions.
3. Create or use a saved disposable chat and use the existing F03 GUI to provision a **new v2 collection** with the exact embedding source, model, dimension and metric. Existing legacy memory collections are intentionally not converted by F09.
4. Use the F04/F06/F07/F08 local manual pilot appropriate for your backend to insert one synthetic test record and verify it with F02 scoped get/list. Do not bypass any permission restriction; stop if the pilot's host acceptance fails.
5. Open **F09 — verified v2 memory retrieval preview**. Select the backend, current saved chat or owned lorebook, the exact embedding profile and a query vector of the correct dimension. You can use text-to-vector generation here only for an already configured WebLLM source; other sources need a valid vector until the server-managed embedding path is completed.
6. Click **Preview scoped v2 retrieval (no injection)**. Verify that the expected UUID record appears with text and revision and that the status explicitly says **not injected; not a complete inventory**.
7. Test a different saved chat or copied-integrity branch. Ensure no cross-branch record appears. Try an unsaved or removed chat; retrieval must be refused.
8. The preview must never cause a create, edit, delete, reindex, purge, or prompt injection. The original automatic memory-write safety gates should remain active. If a request reports an unverified/uncertain response, do not assume records were written or erased.
9. For failures, capture the plugin machine-readable `code`, backend and F03 receipt status, without revealing API keys or chat text.

Do not use this checkpoint for valuable production memories. It does not certify the full F09 end-to-end workflow.
