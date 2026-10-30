# VectHare — Step 6: C04 / C06 / C07 identity & contract checkpoint

Date: 2026-10-27. Baseline: `VectHare-I18-Phase0-C01-C04AB-C06AB-C11AB-C03-C07-C02-Checkpoint.zip`.

## C04 — registry and ownership
- Fixed `utils/c04-ownership.js`: a collection with both exclusive chat and character locks now requires **both** to match. Former OR condition admitted a matching character even for a different chat.
- A collection metadata object carrying a qualified `collectionKey` cannot be used as ownership evidence for a different collection.
- Preserved the existing versioned, dry-run-only registry migration, review gates, owner quarantine, backup and rollback. **No automatic registry migration was performed.**

## C06 — backend interface and configuration
- Expanded `utils/c06-scoped-facade.js` with `count`, `getByIds` and `updatePayload` methods and stricter item/point tenant validation. All methods require independently verified capability flags; unknown capabilities cause a pre-dispatch refusal. Count failure is not represented as zero; incomplete point reads and unproven payload changes are not success.
- Strengthened scoped deletion to require point-level tenant filtering and unique, nonempty IDs; scoped upserts reject explicitly foreign collection markers.
- Added `utils/backend-configuration.js`: in-memory connection fingerprint covering source/model, embedding setup, backend server parameters, tenant mode and credentials. Secrets are not stored in files or logged by this helper.
- Updated `backends/backend-manager.js`: invalidates cached instances and failed-health entries when configuration changes; protects cache state from out-of-order concurrent initialization responses.
- The typed facade remains a **new safe contract interface, not yet the only runtime route**. Existing adapter methods and raw fetch paths must still be reviewed/replaced. No plugin code was modified.

## C07 — identity, migration planning and fingerprints
- Added `utils/c07-physical-migration.js`: read-only physical-record ID migration plans require an independently complete, scope-matched inventory, individually reviewed durable identities, unique target IDs, original text and vectors (or separately verified re-embedding), and strict remapping of parent/link/summary references.
- A caller may execute a reviewed plan **only** by explicit opt-in with verified contracts, fresh inventory and a C02 `replaceRecords` callback. C02 must produce a matching committed deletion receipt; transport loss and ambiguous outcomes remain reconciliation-required. No automatic migration or live execution path was enabled.
- Added `embeddingProfileFingerprint` to `utils/record-identity.js` and stamped the new versioned embedding profile on generated chat-chunk metadata. Provider credentials and endpoint URLs are not stored in the stamp. Legacy records without the stamp remain unverified; there is no silent re-embedding.
- The existing Standard backend physical hash and all existing data remain unchanged.

## Tests
- Added `tests/c04-c06-c07-completion.node.test.mjs` (35 tests) and `tests/c06-backend-cache.node.test.mjs` (2 tests).
- Updated the isolated C07 chat-grouping test harness to supply the new embedding fingerprint helper.
- Re-ran all existing Node test suites plus JavaScript syntax and ZIP integrity checks. See `C04-C06-C07-COMPLETION-VERIFICATION.md`.

## Still NOT complete (do not bypass)
- C04 deployment migration: approved remap UI, verified SillyTavern durable settings write/readback, real chat rename/import/branch verification.
- C06: deployed plugin-version pin, tenant-scoped point read/write/delete semantics, validated live inventories, direct-adapter call-site conversion, negative multitenant integration tests.
- C07: physical ID rollout with original vectors and scoped readback, verified `updatePayload`, complete reference-store migration (scene/policy/metadata), end-to-end browser reload and backend tests.
- C01/C02 destructive deletion/replacement stays blocked. The read-only Similharity plugin source does not prove safe tenant deletion or durable acknowledgements.

**Classification:** improved C04/C06/C07 locally tested safety and migration groundwork; full original-group acceptance **remains partial and live-blocked**. This is a development checkpoint, not a production-certified release.
