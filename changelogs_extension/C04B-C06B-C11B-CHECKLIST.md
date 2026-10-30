# C04-B / C06-B / C11-B prerequisites — completion and blockers

| Item | Status | Notes |
|---|---|---|
| C04-B registry dry run, conflict detection, explicit mapping | LOCAL PASS | New migrator and regression tests |
| C04-B versioned backup, rollback, stale-plan rejection | LOCAL PASS | Commit available only with caller-supplied durable persistence ACK; not activated by default |
| C04-B large-registry backup safeguard | LOCAL PASS | >2 MiB requires external durable store |
| C04-B preserve locks and disabled flags | LOCAL PASS | No migration merges conflicting owners; imports quarantined |
| C04-B enforce origin and qualified chat selection | LOCAL PASS / PARTIAL | Runtime activation checks covered; wider retrieval and UI call sites still need C04 completion |
| C04-B qualified IDs for new content collections | LOCAL PASS | Prior callers may still create legacy keys, requiring remaining C04 migration |
| C04-B user-facing remap workflow and durable save | BLOCKED | Need approved UI flow and host/plugin durable storage acknowledgement |
| C04-B full old-registry migration in deployed ST | NOT EXECUTED | No automatic migration; no user data has been transformed |
| C06-B typed facade for future collection operations | LOCAL PASS | Not the sole path yet; broad legacy call-site conversion still pending |
| C06-B mock tenant/request/outcome contract tests | LOCAL PASS | New tests + A-stage adapter tests |
| C06-B pinned live Similharity schema per backend | BLOCKED | Server source/version/commit and disposable live test needed |
| C06-B verified cross-tenant isolation, vector ACK and purge contracts | BLOCKED | Capability ledger remains `unknown`, safe operations fail closed |
| C11-B exact-owner pages + independently verified count | LOCAL PASS | Adapter bridge refuses legacy/capped response |
| C11-B server-backed pagination/list/count adapters | BLOCKED | No pinned API semantics or live fixture; no capability promotion |
| C11-B registry discovery never auto-deletes | LOCAL PASS | Both plugin and fallback paths preserved |
| C11-B full streamed JSON/NDJSON exporter | LATER C11 | Current JSON export labels inventory unverified and refuses fixed cap |
| C11-B PNG large-collection limit/streaming | LATER C11 | Existing Phase 0 PNG parser hardening preserved |
| C01 live destructive deletion | STILL BLOCKED | Verified scope, pagination/count, purge ACK, durable settings persistence required |
| I01–I18 regressions | PASS | 199/199 |
| Phase 0 | PASS | 33/33 |
| C01 | PASS | 35/35 |
| C04-A/C06-A/C11-A | PASS | 24/24 |
| New B-stage | PASS | 31/31 |

**Next decision:** The locally implementable B-stage prerequisites are in the cumulative build. Do not turn on destructive operations or mark full C04/C06/C11 complete without the pinned server and durable-persistence work. With those blocked, independent C03/C07 foundation development can proceed; C01 live acceptance must wait.
