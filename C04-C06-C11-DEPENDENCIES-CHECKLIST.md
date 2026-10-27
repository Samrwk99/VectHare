# C04 / C06 / C11 dependency checklist — staged, not complete

| Requirement | State | Evidence / limitation |
|---|---|---|
| C04-A: reject qualified backend/source mismatch | LOCAL PASS | `utils/tenant-route.js`, adapter enforcement, dependency tests |
| C04-A: Standard physical-ID routing | LOCAL PASS | `backends/standard.js`, mock-fetch assertion |
| C04-A: legacy aliases retained safely where unambiguous | PARTIAL | legacy bare IDs retained; full registry ambiguity remap/migration is C04-B |
| C04-B registry migration and ownership | NOT DONE | Needs backups, dry run, explicit remap and rollback |
| C06-A: unknown tenant contracts fail closed | LOCAL PASS | contract ledger, Milvus/Qdrant guards, no-network tests |
| C06-A: direct targeted delete and purge entry points blocked | LOCAL PASS | adapters plus C01 higher-level coordinator; mocks assert no request |
| C06-A: independent physical tenant isolation verified | LIVE BLOCKED | no pinned running Similharity server/source |
| C06 full facade and provider vector contracts | NOT DONE | stage B, schema verification required |
| C11-A: cursor and offset iterator | MOCK-TESTED | `utils/c11-paginated-inventory.js`; explicit terminal proof |
| C11-A: 120k+ records enumerated | MOCK-TESTED | 120,001 records, 25 pages and count match |
| C11-A: plugin pagination/tenant schema | LIVE BLOCKED | adapter raw list is not a verified scoped page; bridge fails closed |
| C11-B streaming exports and PNG policy | NOT DONE | full C11 later |
| C01 safe deletion now live | NO | remains blocked by contracts and durable persistence |
| I01–I18 tests | PASS | 199/199 on complete serial rerun |
| Phase 0 tests | PASS | 33/33 |
| C01 tests | PASS | 35/35 |
| New dependency tests | PASS | 24/24 |
| Syntax check | PASS | all JS and MJS |

**Decision:** Use this as a cumulative development baseline. Do not turn on live deletion, cross-tenant point operations, or migration based solely on these mocked tests.
