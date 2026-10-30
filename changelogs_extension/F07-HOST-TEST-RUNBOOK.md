# F07 host test runbook — Vectra vs native Standard

1. Back up both current components and all valuable vectors/chats. Use a disposable SillyTavern profile or installation, never production data.
2. Replace **both** VectHare and Similharity with the F07 matched ZIP contents; restart SillyTavern. Confirm the extension recognises plugin version `3.2.10-s10.11-f07` and that build/capability discovery does **not** claim normal production writes.
3. For plugin Vectra, open a **saved disposable chat**. In `F03 — new v2 collection setup`, choose `vectra`, enter a valid embedding source/model/dimension/metric, preview the derived index and explicitly confirm creating the empty v2 index. Check the provisioning receipt is `SCHEMA_VERIFIED_OFFLINE_UNCERTIFIED`.
4. Use F02 v2 read developer panel for the same source and embedding model. An empty list is expected. This does not read existing legacy Standard data.
5. Run `F07 — Vectra local disposable acceptance`. This creates a separately named new index and synthetic record, validates insert/query/metadata/stale revision/page/reopen/delete, and leaves the test index in place. Record the 11 stages and any machine-readable error code.
6. Optionally use `F07 — Vectra v2 manual mutation PILOT` against the newly F03-provisioned chat index. Supply the **exact** embedding source/model/dimension/metric from step 3, float32-roundtrip-safe vector values, and a disposable record. Explicitly consent for EACH operation. Use the read-only receipt checker when uncertain; NEVER retry an uncertain operation automatically.
7. Run `ST Vector Endpoints` separately. Native Standard `list` and `query` may be probed; `insert`, `delete` and `purge` must display as NOT TESTED. A refusal is not a backend failure and HTTP 403 must not be a green check.
8. Restart SillyTavern, verify the same F03 receipt and known synthetic record state (or empty state after deletion). Switch disposable chats/users to inspect isolation. If any operation is uncertain, preserve logs/receipts and stop mutation testing.
9. Test on Termux, Windows and Linux where feasible. Provide installed Vectra/SillyTavern versions and the full first failing stage/code. No manual JSON credentials are required for local plugin Vectra.

**Guardrail:** Do not run F07 on valuable or legacy indexes; do not run native Standard mutation tests until a separate host-authorized contract is established. No one-click purge or automatic migration is provided.
