# Step 6 — C04 / C06 / C07 completion checklist

| Requirement | State | Reason / evidence |
|---|---|---|
| C04 qualified collection keys across earlier implemented paths | PRESERVED | A/B helper tests retained |
| C04 verify both exclusive lock dimensions | PASS | New race/ownership tests |
| C04 reject foreign qualified metadata | PASS | New owner test |
| C04 migration preview, conflicts, backup and rollback | PRESERVED | Existing 31 B-stage tests |
| C04 user-approved migration UI with persisted confirmation | BLOCKED | Host durable ACK/readback not available |
| C04 fully migrated real registries, chat branches/imports | NOT DONE | Real host/storage acceptance required |
| C06 scoped count/read/update typed operations | LOCAL PASS | New mocked facade tests; unknown remains blocked |
| C06 scoped upsert/delete validation | LOCAL PASS | New cross-tenant tests |
| C06 config-sensitive backend instance invalidation | LOCAL PASS | Isolated backend-manager tests |
| C06 adapter-only runtime boundary | PARTIAL | Existing direct adapter/fetch paths remain |
| C06 verified tenant-safe Qdrant/Milvus purge and full per-backend contract | BLOCKED | Unchanged plugin source lacks required proof; live tests absent |
| C06 validated model/provider routing and embedding-vector support | PARTIAL | No live provider/server verification, no capability promotion |
| C07 logical qualified IDs/message UIDs/scenes | PRESERVED | Earlier C07 40-test suite |
| C07 versioned embedding configuration stamp on new chat chunks | LOCAL PASS | New regression tests; legacy fingerprints unverified |
| C07 read-only physical ID migration plan | LOCAL PASS | 35 new completion-suite tests (including C04/C06) |
| C07 C02-coordinated migration opt-in handoff | LOCAL PASS / NOT ACTIVATED | Callback tested; requires verified live contracts, complete fresh inventory and reviewed external references |
| C07 actual physical backend ID migration and affected link-store conversion | BLOCKED | No verified client ID/get-by-ID/upsert/delete contract or live acceptance |
| Earlier C01/C02 destructive operation safety gates | PRESERVED | No capability flags changed |
| Read-only plugin unaffected | PASS | No plugin files bundled or written |
| Original I01–I18 regressions | PASS | 199/199 |
| Phase 0 | PASS | 33/33 |
| C01 | PASS | 50/50 |
| C04/C06/C11 A/B | PASS | 24/24 + 31/31 |
| C03 | PASS | 38/38 |
| C07 prior | PASS | 40/40 |
| C02 | PASS | 50/50 + 11/11 |
| New completion and backend-cache suites | PASS | 35/35 + 2/2 |

**Verdict:** finishable local safeguards delivered; group-wide live acceptance is NOT met. Do not enable unsafe deletion, imports, or vector ID migration. Next scheduled independent step is C05; return to blocked prerequisites when real SillyTavern/server evidence is available.
