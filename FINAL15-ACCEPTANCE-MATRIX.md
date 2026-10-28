# VectHare — Step 15 acceptance matrix

**Basis:** delivered C14 ZIP, cumulative source checklists, 863 Node assertions and a read-only audit of the supplied Similharity plugin ZIP. **No actual SillyTavern/browser/remote database instance was exercised.** A locally passing test is not a live acceptance certificate.

| Group | Local source/regression outcome | Live acceptance | Outstanding gate |
|---|---|---|---|
| I01–I18 | **PASS** 199 tests | **NOT TESTED LIVE** | Installed host workflow and UI smoke tests. |
| Phase 0 | **PASS** 33 tests, including P0-9 | **PARTIAL** | Pin plugin/host contracts; keep unknown capabilities unavailable. |
| C01 deletion & recovery | **PASS locally** 50 tests | **BLOCKED** | Tenant-safe purge/count, independently complete inventories, durable tombstones, protected backup acknowledgement and live fault tests. |
| C02 replacements/imports | **PASS locally**, Step 15 journal-kind integration fix | **BLOCKED** | Server-backed deterministic IDs, upsert and readback, tenant-safe removal, durable browser journal and recovered import source. |
| C03 chat jobs | **PASS locally** 38 tests | **UNVERIFIED LIVE** | Real chat switching, abort timings, reload and multi-tab interactions. |
| C04 identity/registry | **PASS locally**, Step 15 many-to-one mapping fix | **BLOCKED for migration** | Host durable settings ACK, reviewed migration UI, restored/branched chat ownership tests. |
| C05 credential security | **PASS local restriction checks** 47 tests | **BLOCKED for authenticated providers** | Plugin-side per-user protected secret resolver, live secret lifecycle and legacy backups cleanup. |
| C06 backend facade/tenancy | **PARTIAL** local facade tests | **BLOCKED for certification** | Remaining direct adapter paths and independently verified server tenant/point/purge/write contracts. |
| C07 record identity | **PASS local logical identity and planner**, Step 15 source-collision fix | **BLOCKED for physical migration** | Real server physical ID support, complete stable references and transaction commit proof. |
| C08 activation/frequency | **PASS local context/ledger and Step 15 C10 bridge** | **GATED** | Validate World Info timing, final host prompt receipts, storage reliability, reload/swipe behavior; do not activate frequency-conditioned injection yet. |
| C09 retrieval/hybrid | **PASS local selection tests** | **PARTIAL / BLOCKED** | Scoped getByIds for hard links and genuine independent lexical index/endpoint proof. |
| C10 prompt budget/receipt | **PASS local planner/receipt tests and Step 15 bridge** | **UNVERIFIED LIVE** | Host assembled-event payloads, actual tokenizer/model context behavior and multiple prompt positions. |
| C11 inventories/exports/PNG | **PASS local 120k+ export and PNG tests; Step 15 fail-closed receipt tests** | **BLOCKED for verified backend exports** | Real complete paginated tenant inventory, independent counts, stable snapshot evidence, browser disk-write durability. |
| C12 scene/temporal | **PASS local** 37 tests | **PARTIAL / BLOCKED** | Scene reindex uses C02+C06+C07 verified replacement, real chat scene persistence and UI tests. |
| C13 chunking | **PASS local** 44 tests | **PARTIAL / BLOCKED** | Live strategy rebuilds and reference migrations, uploaded-scene browser tests. |
| C14 similarity classification | **PASS local synthetic classifier** 32 tests | **UNVERIFIED LIVE** | Pin actual local embeddings model; evaluate real label precision/neutral rate and model change invalidation. |

## Global safety/release gate

**Current classification: DEVELOPMENT / TEST ONLY. Not production-certified.** The source has deliberately blocked many destructive, migration, authenticated, frequency and verified-export workflows. Maintain the blocks until acceptance evidence is obtained. Do not test shared-collection Qdrant or Milvus operations against irreplaceable data.

## Next evidence to obtain from an operator

1. SillyTavern build/commit, actual installed Similharity plugin hash and deployed backend versions; confirm whether the supplied ZIP exactly matches deployment.
2. Disposable, backup-protected host/DB environment with two tenant collections and representative embedding models/dimensions. No destructive smoke tests on user data.
3. Host event recordings for chat/World Info/prompt assembly, storage/reload tests, and real C14 labelled accuracy results.
4. A compatible plugin revision (a separate later project change) providing safe tenant-filtered operations and protected secret resolving; this checkpoint does not modify the plugin.

