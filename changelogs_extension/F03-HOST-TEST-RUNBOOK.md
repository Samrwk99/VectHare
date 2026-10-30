# F03 SillyTavern Host Acceptance Runbook — disposable data only

**Install** the F03 matched extension/plugin in a separate testing instance, backed up beforehand. Use the standard VectHare GUI to configure Qdrant or Milvus. Start with **local Qdrant on Termux**, since that is the currently available live backend. No browser developer-console patches or manual JSON configuration should be necessary.

## Safe Qdrant acceptance steps

1. Confirm that SillyTavern and the local Qdrant service are running. Qdrant typically responds at `http://127.0.0.1:6333/collections`; check from Termux with `curl -fsS http://127.0.0.1:6333/collections`. Do not paste API keys into logs/screenshots.
2. In VectHare, select Qdrant Local and use **Save connection & test**. Use a **newly saved disposable character chat**, not a valuable old chat or cloned data.
3. In the **F03 — new v2 collection setup** panel, select Qdrant and enter the *actual* embedding model name, dimension and metric. These must match the embedding model you will later use; F03 does not infer or test an embedding model.
4. Click **Preview v2 collection**. This checks authenticated saved-source ownership, reserves the S02 collection mapping, and displays the generated `vh2_...` name. It must not contact Qdrant to write vectors.
5. Click **Confirm creation of NEW empty collection** **only if** the name represents disposable test data. This performs Qdrant collection creation and indexed schema verification only; it will not insert memory records or migrate old records.
6. Click **Check previous provisioning receipt**. Expected: `SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED` (the wording flags that the code's check is not a certification of the host). An `UNCERTAIN` state requires investigation; do not retry blindly.
7. In F02's guarded read panel, select the **same backend, source, model, dimension and metric** and list the source's records. For a new empty Qdrant collection, a successful list should show zero records. Read results remain non-snapshot display pages.
8. Restart SillyTavern and repeat the F03 receipt-status check and the F02 read. The original source mapping must persist and a second attempt to provision the same collection must be refused rather than overwriting it.
9. Repeat for a **second disposable branch**, including a branch created by copying parent chat metadata. It must receive a different derived source-bound collection. Do not assume a copied integrity field is a trustworthy branch ID.
10. For safety, test refusal of a request missing the explicit confirmation, a wrong name, and an attempt to provision an existing collection. Record status codes without credentials or chat content. Do not physically purge collections as part of F03 acceptance.

## Milvus

Use the VectHare GUI's Milvus connection settings and a newly saved test chat. Repeat preview, confirm, receipt/status, F02 read and restart. Save the Milvus server/SDK version and any errors. The actual SDK schema/index lifecycle has not yet been verified on a live Milvus server, and a partial create may leave a collection in place.

## Expected restrictions

- The ordinary **Vector Insert**, **Vector Delete**, revectorize, summary-memory mutations, and legacy Qdrant inventory tests are still blocked.
- If the GUI says `F03_PROVISION_UNCERTAIN`, capture the code and `vh2_...` name. Inspect the database schema read-only; never clear/drop the collection or delete the receipt without a recovery plan.
- The F03 preview/status paths are source-authenticated but are not a complete inventory, verified backup, or production authorization.

## Evidence to return

Record: SillyTavern version, OS/Termux version, plugin/extension versions, backend version, connection-test result, F03 preview name, provision result, receipt status after restart, F02 empty list result, branch-isolation results, and sanitized error codes. A pass here establishes schema creation on your host but does not prove live insert/update/delete, which remains F04.
