# M3c — Versioned binding and verified restored-target evidence

Baseline: VectHare 2.2.0-alpha.m3.2 + Similharity 3.2.10-m3.2 (M3b).
Output: VectHare 2.2.0-alpha.m3.3 + Similharity 3.2.10-m3.3.

**Classification: implementation progress, M3 not complete; no production capability promotions.**

## Implemented
1. `lib/m3-versioned-binding.js`: server-only, process-local attestation of a journal-derived physical target and generation; rejects an unmarked/forged physical alias. Canonical S02 key and source/embedding identity remain unchanged.
2. `lib/m3-cutover-journal.js`: new internal `resolveVersioned` requires live per-target schema, inventory and receipt verification before returning an alias; `assertCurrentVersioned` rejects a binding after an interrupted transition or later generation/rollback.
3. `lib/s05-contract.js`: verifies marked aliased bindings without relaxing ownership/record checks. Canonical reads remain backward-compatible.
4. `lib/s04-contract.js`: optional trusted, marked physical binding in S04 plans, explicitly including `routingGeneration`. Untrusted arbitrary physical names still cannot select a target.
5. `lib/s04-engine.js`: rejects aliased plans without a trusted generation-fencing callback; checks the fence before the ledger intent and before `SUBMITTED`; refuses to promote reconciliation of a stale generation. Normal canonical paths keep existing behaviour.
6. `lib/m1-saved-records.js`: M1 tickets now bind the physical collection and generation; applies recheck both after claim and before dispatch. An alias-aware gateway path is prepared, but the public F02 alias guard remains shut.
7. `lib/m3-target-receipts.js`: internal complete, unfiltered Qdrant target inventory/schema/index/vector comparison, immutable restored-target receipts, re-verification, and a journal → receipt → live backend resolver. No public restore endpoint or activation shortcut.
8. `lib/m3-collections.js`: `M3Store` supports append-only target receipts; existing restore/delete production endpoints remain denied.
9. Added `tests/m3-versioned-binding.test.mjs` and `tests/m3-target-receipts.test.mjs`; updated extension M3 UI help text to reflect truthful status.
10. Rebuilt Similharity source-integrity manifest.

## Unchanged safeguards
- No browser-provided physical collection, vector, text, owner ID, backend URL or credentials.
- Legacy S01/S04 mutation denials and unrestricted `/purge-all` remain blocked.
- Restore/decommission are not promoted from disposable tests to production execution.
- No automatic uncertain-operation replay or retained physical lock release.
- No production capability matrix cell set to `ENABLED` without real-host acceptance.
