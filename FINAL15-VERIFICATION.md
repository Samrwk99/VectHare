# VectHare — Step 15 full verification and compatibility audit

**Verification outcome:** **863/863 local regression/integration tests passed**; **174/174** JS/ESM syntax checks passed. **Live compatibility and production acceptance: NOT ESTABLISHED.** This is a corrected development baseline, not an unrestricted production release.

## 1. Inputs, boundaries and repeatability

- Extension baseline: `VectHare-Step14-C14-Cumulative-Emotion-Similarity-Checkpoint.zip` (the latest cumulative C14 build).
- Source plugin: supplied `VectHare-Similharity-Plugin.zip`; **SHA-256 `51f74de9c7e57524cc3f1f881b03069805e654b162a8f5ccb77d012b0a2604a7`**; examined read-only. Plugin source declares `similharity` package version `2.0.0`; deployed runtime version/commit is **unknown**.
- Environment: Node.js v22.16.0, local source/test fixtures. No SillyTavern running host, actual Qdrant/Milvus/LanceDB server, browser profile, or deployed plugin was available.
- Run command pattern: `node --experimental-vm-modules --test --test-concurrency=1 tests/<file>.node.test.mjs`, one file per Node process. Detailed per-file outcomes in `FINAL15-TEST-RESULTS.json`.
- **46 test files, 863 assertions, no failed tests, no skipped/timeout files** on the final run. The earlier Step 14 report mentioned intermittent parallel worker crashes; this isolated serial run did not experience them.
- `node --check` on all 174 `.js`/`.mjs` files completed without errors; archive integrity and SHA-256 are reported separately.

## 2. Cross-stage integration and migration faults

### Three defects found and corrected

- **C07→C02 incompatible operation kind (fixed):** C07 requested `kind:'physical-id-migration'`, but C02's header `KINDS` rejected it. A C07 mock callback incorrectly masked the integration failure. The kind is now registered; Step 15 tests complete a genuine coordinator-backed operation.
- **C07 staged overwrite of a second old record (fixed):** target physical IDs are now rejected if they are occupied by *another* source record in the migration set; prevents destructive upsert-before-verification within the same physical collection.
- **C04 identical-record many-to-one mapping (fixed):** the registry planner now rejects multiple legacy entries resolving to the same qualified key, even if their metadata coincides. This avoids loss of separate ownership/selection records.

### Failure/recovery checks

- C07→C02 happy path verifies inserts, scoped readbacks, confirmed deletes and committed journal.
- C07→C02 lost acknowledgement verifies original records remain and journal phase becomes `needs-reconcile` without a blind delete.
- C04 conflicting mappings are refused before commit; the source settings are unchanged.
- C10→C08 accepts only a verified *included* prompt receipt and records once per stable chat/turn/record across ledger reload; an excluded or stale-chat receipt never counts.
- C11 exporter aborts a failed/incomplete inventory and does not emit a completeness receipt.
- **C11→C01 protected backup:** C11's terminal enumeration receipt does **not** prove that an export was durably saved; C01 correctly refuses to treat it directly as a protected deletion backup. A future explicit durable-export receipt adapter and real save acknowledgement would be required. **No bypass was added.**

## 3. Confirmed plugin compatibility concerns — source audit, not live executions

**CRITICAL — source-level unsafe implicit deletion outside the purge API:**

1. `qdrant-backend.js`, near lines 336–351, may call `purgeAll()` automatically while inserting vectors if dimensions differ. `purgeAll()` (near lines 1092–1103) issues a physical `DELETE /collections/<mainCollection>`. A shared physical collection may contain other tenants.
2. `milvus-backend.js`, near lines 105–123, may drop an existing collection when its vector field is missing or dimensions differ. Its `purgeCollection()` (near lines 472–494) drops `vecthare_main` without filters and catches errors without rethrowing them.
3. The plugin `/chunks/purge` handler (`index.js`, near lines 1408–1439) returns a generic `success:true` after calling the backend handler. In the Qdrant path the supplied `filters` argument is ignored by `purgeAll`. The response cannot prove a tenant-safe purge or a durable zero-record state.
4. The plugin still consumes some credentials from browser request bodies and provides no demonstrated protected per-user secret resolver compatible with the extension's C05 contract. Authenticated providers are intentionally blocked instead of falling back to plaintext browser requests.
5. List APIs and pagination/count behavior are not independently proven to produce complete, tenant-scoped, snapshot-consistent enumerations. Even identical pre/post counts cannot, on their own, prove a stable snapshot if one record disappears and another appears during export.
6. Actual deployed plugin source/version is not attested. Only the supplied archive was inspected; running-server compatibility cannot be certified by source inspection.

These risks must not be tested on irreplaceable shared collections. **The plugin has not been modified** in this checkpoint. The extension's unknown capability flags and destructive-operation barriers remain closed.

## 4. Further unresolved integration gates

- **C01:** live deletion remains disabled. Need trustworthy ownership/complete count/list, fail-propagating scoped purge, durable tombstone saves and protected export acknowledgement.
- **C02/C07:** the new cross-module test proves local composition, not the plugin's support for qualified physical IDs or idempotent scoped writes. Existing record formats and external references cannot be migrated without live contract evidence and a disposable database.
- **C04:** reviewed migration plans and backups work in mocks, but SillyTavern `saveSettingsDebounced()` is **not** a durable save acknowledgement; automated application stays blocked.
- **C05:** credentials stay out of new browser requests/settings where covered locally; existing plaintext backups and authenticated connections require plugin/server work and operator migration.
- **C06/C09/C11:** facade adoption and backend tenancy are not complete; no native full scoped getByIds / lexical / complete export contract is certified. Legacy JSON exports explicitly remain unverified.
- **C08/C10:** prompt registration is not host inclusion. Real assembled prompts, tokenizers, World Info events, browser durable frequency storage, and swipes/regens need host tests; frequency-conditioned injection stays gated.
- **C11/C01:** verified NDJSON terminal receipt is not proof of durable backup. No direct receipt conversion was allowed.
- **C12/C13:** scene reindex and live chunker migrations depend on C02/C06/C07 live proofs.
- **C14:** controlled fake embeddings verify the algorithm only; real emotion classification accuracy/neutral rate remains unmeasured.

See `FINAL15-ACCEPTANCE-MATRIX.md` for each group.

## 5. Recommended real-environment acceptance plan

1. **Freeze versions and prepare disposable data:** record SillyTavern commit/build, installed Similharity code hash/version, Node, embedding model, Qdrant/Milvus/LanceDB versions. Create two isolated test tenants with distinct/overlapping legacy IDs and independent backups.
2. **Prove server isolation without production data:** verify per-tenant point reads, metadata, pagination/terminal/count, dimensions, filtering, error responses, lost acknowledgements, and *no physical collection drops* when model dimensions differ. Record server request/response traces. Server changes require a separate reviewed plugin release.
3. **Test crashes and durable persistence:** kill browser/server between journal and tombstone checkpoints; recover with missing/partial ACKs, IndexedDB failures, settings save failures, revoked credentials, concurrent tabs and incomplete exports. Never automatically re-purge unknown operations.
4. **Host integration:** switch chats during embedding/retrieval, cancel queued writes, verify actual prompt inclusion and token budgets in both prompt modes, World Info event ordering, role/speaker rules, scene timeline persistence, swipes and regenerations. Confirm no stale jobs affect a new chat.
5. **Migration dry runs:** export verified snapshots to a durable destination, review all legacy→qualified mappings, check collisions and foreign-tenant records, then trial reversible registry/physical ID migration in a disposable environment.
6. **Real feature quality:** validate C13 chunk boundaries on actual uploaded chats and test C14 on representative labelled examples using the deployed Transformers embedding model; log confidence and neutral outcomes.

## 6. Release decision

**Development checkpoint: PASS for local regression, failure-injection and cross-module tests.**

**Production/readiness gate: FAIL / BLOCKED, not because the tests failed, but because required live/secure backend contracts and host durability evidence are unavailable and the inspected plugin contains destructive behavior.** Keep restrictions in place. C01–C14 should not be called production-complete merely because their implementation checkpoints were delivered.
