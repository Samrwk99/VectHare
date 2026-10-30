# C11 — acceptance checklist (local work vs live proof)

| Issue / exit criterion | Local implementation | Live status |
|---|---|---|
| #17 Paginate complete inventories; positive terminal and loop detection | PASS — prior C11-A plus new verified export walker | BLOCKED — actual deployed plugin/server count/scope semantics not independently established |
| #198 Qdrant/Milvus/LanceDB backend pagination and tenant scope | PASS for capability-gated mock adapter bridge | BLOCKED — source API `hasMore`/offset cannot be accepted as certified across all adapters |
| #63 Large export beyond 10k and 50k | PASS — 120,001-record bounded writer with explicit receipt | BLOCKED — scoped live adapter capability flags remain unknown |
| #63 Counts, duplicates, changed count, wrong-owner, cursor cycles and write failures | PASS — C11 fault suite | PENDING live tenant/consistency tests |
| #63 Streaming memory | PASS — incremental writer; file-system stream where available, 32 MiB fallback cap | Browser-specific acceptance required |
| #63 Legacy JSON clearly marks incomplete | PASS — `.UNVERIFIED.vecthare.json` suffix and warning | Legacy listing is NOT a complete backup |
| #119 CRC, length, allowlisted types, compressed-output ceiling | PASS — parser, stream guard, mutation tests | PENDING browser fuzz/compatibility testing |
| #118 Bounded Base64 encoding | PASS — retained 8 KiB bounded chunks, earlier regression | PENDING deployed browser coverage |
| PNG large export refusal | PASS — 2,500 chunks or 6 MiB JSON ceiling; points to JSON/NDJSON | Live completeness of source remains separate |
| Existing I01–I18 and C01–C10 work | PASS — cumulative regression suites | Same existing live limitations |
| Similharity plugin untouched | PASS — read-only source inspection; not included in project build | Deployment version not verified |
| Full production C11 acceptance | **NOT YET** | Requires pinned deployed plugin and safe end/count/tenant/snapshot evidence |

## Release decision

This is a **Step 11 C11 checkpoint**, not certification of live full-collection backup. Continue to C12 while keeping the backend capability gates closed. A completed-looking file must never be treated as proof; the verified NDJSON receipt is only available after a separately verified source and successful final count.
