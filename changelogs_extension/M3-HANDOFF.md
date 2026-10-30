# M3 continuation / handoff

Start from `VectHare-M3.zip` and `Similharity-M3.zip`. M3 remains unfinished; do **not** silently proceed to M4 or claim ENABLED.

## Immediate critical path

1. **M3.2 cutover contract:** S02 collection identity currently computes an immutable canonical physical name. S05 `requireReadBinding`, S04 `planMutation`, M1 `resolveContext`/F03 receipt and backend adapters require that canonical name. Design a server-owned versioned physical alias/cutover ledger with authenticated lookup, schema and ownership evidence, quiescing, single-writer exclusion, durable staged/published commit, rollback retention, and fail-closed recovery. An alias cannot be selected by the browser.
2. **M3.1 restoration:** promote the disposable-only `stageM3DisposableRestore` into a separately certified trusted gateway operation with new target provision receipt, scoped fresh-target inventory, no replay after ambiguous dispatch, exact schema/vector/metadata/readback and smoke-query verification. Do not add a production route until cutover and certification integrate.
3. **M3.3–3.4:** owned collection decommission requires mandatory verified backup, typed consent, M2 lease exclusion, S04 ledger reconciliation, F09c.10 physical lock, collection receipt and server-side S02 DELETED tombstone; uncertainty keeps binding+lock. `empty` reuses this lifecycle and re-provisions an identical schema. Keep `/purge-all` blocked forever.
4. **M3.5:** build changed-model vector inventory through source-attested M2 jobs into a newly provisioned collection, then run the shared cutover and rollback. Never mix model/dimension/metric in place.
5. Continue the M0/M1/M2 real-Qdrant acceptance work and production capability evidence track. Live tooling needs a disposable latest-stable SillyTavern + authenticated Qdrant connection.

## Existing M3 code

- Server `lib/m3-collections.js`: inventory, backup, plan, internal disposable restore, HTTP registration.
- Frontend `utils/m3-collections-gui.js`, E02 guarded browser intent rules.
- Safety: `tests/m3-collections.test.mjs` and `tests/m3-collections-ui.node.test.mjs`.
- Do not weaken the S01/S04/M0 gates or fake F03 receipts. S10 source manifest must be regenerated after executable changes.
