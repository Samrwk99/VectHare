# VectHare — C02 checkpoint issue checklist

**Classification:** C02 safety/journal checkpoint locally implemented and tested; **full C02 acceptance remains blocked** by server contract and real-runtime verification. The 13 original C02 issues remain in their assigned group.

| Issue | Status at this checkpoint | Remaining acceptance evidence |
|---|---|---|
| #89 Edited-message refresh | Phase 0 preservation | Real chat edit/reload proof and C02 transaction semantics |
| #103 Old/new hash mapping | Phase 0 preservation + new set-difference coordinator | Full legacy chat repair through the journal and verified physical IDs |
| #156 Content-vectorizer replacement | Prior fail-closed preservation | Backend-safe replacement/rollback activation |
| #159 Dedup with complete exact-hash recovery | Unsafe fix remains blocked; injectable coordinator supports staged replacement | Complete scoped inventory, record-level duplicate IDs, verified deletes |
| #205 Atomic imports | Durable journal + fail-closed integration implemented | Real server proof; resumable source re-supply; compatibility test of imported vectors |
| #104 No delete of just-inserted hash | Implemented in coordinator and test | Live adapter acceptance |
| #202 Idempotent batch writer | Removed blind retry, deterministic-ID list/diff/retry engine in tests | Backend upsert/idempotency contract, full inventory, streaming partial batch resume |
| #77 Re-embedding | Both editors journal route, old vectors preserved | Live verified upsert/readback and safe deletion activation |
| #146 Pending edit save | Per-chunk pending state retained on unverified write | Live partial-edit/metadata and summary workflows |
| #82 Scene replacement | Scene creation/split fail closed, original intact | Journal-backed multi-record scene split and backend acceptance |
| #38 Overwrite purge false | Existing Phase 0 block preserved | Safe validated overwrite transaction with verified server delete |
| #47 Success-state correctness | Prior fix preserved; C02 rejects uncertain completion | Host UI end-to-end verification |
| #122 Import acknowledgement/count | Existing checks retained; no ACK-only success | Pinned per-backend accepted count semantics |

## Exit checks

- [x] 199/199 earlier I01–I18 tests, 33/33 Phase 0, 50/50 C01, 24/24 C04/C06/C11 A, 31/31 B, 38/38 C03, 40/40 C07, 2/2 plugin evidence.
- [x] 50/50 C02 operation/journal tests and 11/11 C02 integration tests.
- [x] ZIP integrity and JavaScript syntax checks.
- [x] No text/vector/credential payload stored in the C02 journal.
- [x] Non-idempotent insert retries removed, old-minus-new deletion and no-blind-retry recovery fault tested.
- [x] Unsafe live C02 import, re-embed and scene split refused before network dispatch.
- [ ] Pin actual deployed backend versions and independently verify scoped pagination/count, IDs, upsert semantics, tenant filters and acknowledgements.
- [ ] Wire validated live `listScopedPage` / `countScopedRecords` and actual delete proofs for all intended backends.
- [ ] Test browser IndexedDB writes/reloads, quota failures, multiple tabs, browser storage reset, interrupted imports and actual SillyTavern settings persistence.
- [ ] Complete end-to-end remapping of chat/scene/parent links with C07 physical record identity work.
- [ ] Confirm the re-embed and import UI feature flows in an installed disposable SillyTavern instance before enabling.

**Do not mark C02 complete or production ready based solely on these local tests.**
