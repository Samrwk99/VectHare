# F05 Host acceptance runbook — Termux local Qdrant

## Before testing

Use a disposable SillyTavern installation/profile and a disposable Qdrant instance or database. Back up current vectors and the prior working VectHare/Similharity pair. Keep your valuable user data out of the test environment. Install **both** F05 matched components: VectHare S11.10-F05 extension and Similharity S10.9-F05 plugin. Fully restart SillyTavern so the exact fingerprint pair is loaded.

Make sure the Qdrant server is reachable on the loopback interface using the backend connection settings in **VectHare's GUI**. For normal local installations it is `127.0.0.1:6333`; custom local ports should be configured in the GUI. Cloud Qdrant is intentionally excluded from the F05 diagnostic. No private JSON file or environment variable should be necessary for ordinary local setup with the GUI-configured plugin.

## Run the extended test

1. In SillyTavern, open VectHare settings and confirm the S10.9-F05 plugin is recognized.
2. Select **local Qdrant** and test the connection.
3. Find **F05 — Qdrant extended live acceptance (disposable only)** and click **Run extended disposable Qdrant acceptance**.
4. Confirm the dialog after reading it. The plugin creates a *new*, generated v2 collection and inserts/changes a **synthetic** 4-dimensional vector. The collection is left behind, even on success. It must never reuse a legacy collection or automatically purge records.
5. Record the results for these stages: `provision`, `schema`, `owner_indexes`, `insert`, `readback`, `search`, `metadata`, `stale_revision`, `pagination`, `reopen`, `delete`, `empty_after_delete`.
6. If the test reports failure or uncertainty, **do not rerun operations against the same collection or manually purge it**. Save the sanitized stage/error codes and inspect any uncertain operation receipt first. A new top-level diagnostic run generates a new collection, but avoid collecting many failed diagnostic collections without investigation.
7. Restart SillyTavern, check VectHare GUI connection and plugin build identity again, then run the test only on a fresh disposable environment as appropriate. Note: this *does not prove restart durability* for the first run; a dedicated reopen-after-process-restart test is still required.

## Evidence to share

Record: Termux version, Node version (`node -v`), SillyTavern version, Qdrant version, F05 extension and plugin versions, whether the local connection succeeds, the F05 PASS/FAIL status and its stage names with sanitized error codes. Do not share API keys, private user directory names, chat text or raw vectors. You can paste the sanitized GUI status message.

## Critical restrictions

**F05 PASS does not enable ordinary chat vectorization.** It proves only the specified disposable flow on the host and backend that actually executed it. External writer atomicity, crash durability, real chat/branch ownership, normal embeddings and prompt injection are separate acceptance gates. No legacy migration, full export, bulk purge or automatic memory CRUD should be enabled based on this diagnostic alone.
