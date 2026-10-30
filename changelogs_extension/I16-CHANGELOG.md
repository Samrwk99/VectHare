# VectHare I16 — Change Report

**Base:** VectHare I15 cumulative ZIP. **Output:** VectHare I16 cumulative ZIP (I01–I16).

## Issues addressed

| Issue | Change |
|---|---|
| #160 | Both Diagnostics **Fix Now** paths use the existing extension settings; group repair now calls the real `setCollectionMeta()` API rather than a nonexistent save function. |
| #174 | Group-member checks report unavailable or capped inventories as **warning**, not PASS or repairable. The repair path skips unverified collections rather than deleting based on incomplete reads. |
| #164 | Condition-rule check reads `{hashes, metadata}` and validates actual `conditions.rules` with `validateConditionRule(rule)`, including saved disabled rules. Missing metadata generates a warning. |
| #173 | Activation Triggers diagnostic tests positive, negative and scan-depth matches using the same trigger matcher as collection activation; it is now included in the production diagnostic run. |
| #172 | Keyword Boosting diagnostic checks current bounded, confidence-scaled boosting, score cap, matched keywords and result ordering rather than obsolete 2.5x multipliers. |
| #219 | Diagnostics report uses `qdrant_use_cloud` and `qdrant_url` instead of obsolete Qdrant setting names. |
| #165 | Production retrieval check calls VectHare's selected-backend `queryCollection()` rather than the hardcoded native `/api/vector/query` endpoint. |
| #168 | Production storage test attempts cleanup in `finally`, requires confirmed purge, and reports cleanup failure. Test registry records are **not** unregistered after a failed purge. Plugin embedding test also fails rather than claiming success if cleanup fails. |
| #179 | Temporally Blind Chunks test restores preexisting metadata or deletes its temporary metadata in `finally`. |
| #178 | Temporal Decay diagnostic tests enabled decay via an explicit fixture and separately tests disabled-mode passthrough, independent of users' default setting. |
| #166 | Dimension check reports **warning** instead of PASS when chat, stats or stored embedding dimensions are unavailable. |
| #196 | Successful queries update collection `lastUsed` and `queryCount` using exact or unambiguously resolvable metadata identity; ambiguous bare IDs are not guessed. |

## Files changed

- `diagnostics/index.js`
- `diagnostics/configuration.js`
- `diagnostics/activation-tests.js`
- `diagnostics/production-tests.js`
- `core/collection-metadata.js`
- `core/core-vector-api.js`
- `ui/ui-manager.js`
- `tests/i16-diagnostics.node.test.mjs` (new)
- `package.json`
- `I16-CHANGELOG.md` (new)

## Verification

- **I16 regression tests:** 18/18 passed.
- **Cumulative I01–I16 regression tests:** 181/181 passed.
- **JavaScript and `.mjs` syntax:** 99 files checked successfully.
- **ZIP integrity:** checked after packaging.
- **Live SillyTavern/Similharity integration:** **not run**.

To rerun: `npm run test:i16` or `npm run test:repair`.

## Remaining limitations

- Backend list endpoints currently cap inventories at `VECTOR_LIST_LIMIT=10000`. I16 now refuses the relevant destructive group cleanup at the cap; complete pagination and independently provable inventory completeness remain **Phase 2 C11/C01** work.
- Successful backend responses and capability contracts still require live server verification (**Phase 2 C06**).
- A failed purge preserves its diagnostic marker for the immediate cleanup result; full persistent restart/reconciliation semantics remain **Phase 2 C01/C02**.
- Cross-backend canonical collection identity and resilient usage accounting remain **Phase 2 C04**.

No unrelated repair groups were intentionally modified.
