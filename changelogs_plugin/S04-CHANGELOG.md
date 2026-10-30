# S04 — Safe Mutation Contracts and Recovery Foundation

**Date:** 28 October 2026  
**Baseline:** `VectHare-Similharity-S03-Authorization-Isolation.zip`  
**Plugin version:** `3.2.4-s04.0`  
**Extension modified:** No  
**Live host / backend certification:** No  
**Vector writes reactivated:** **None**

## Delivered

1. `lib/s04-contract.js`: schema-v4 mutation intent validator for `insert`, `update`, `metadata`, and `delete`; canonical S02 scope and embedding mapping, stable S02 record/physical IDs, operation UUIDs, expected/target revisions, finite-dimensional vectors and protected-metadata validation. Plans include **only fingerprints** of text/vectors/metadata, never the raw payload. Branches are separated *if* their host identities differ. Validation is not authorization.
2. `lib/s04-ledger.js`: per-authenticated-user, private on-disk receipt ledger; operation-ID exclusivity, receipt checksums, atomic replacement plus file/directory `fsync`, cross-process directory locks, record-scoped locks and immutable state-transition rules. No automatic stale-lock breaking after crashes; manual safe diagnosis required.
3. `lib/s04-engine.js`: **internal testable coordinator only**. Requires a backend adapter and a separate trusted `authorize` callback attesting ownership and certified mutation contract. Validates/re-derives the plan, reads prior record/revision, records `SUBMITTED` **before** calling an adapter, independently checks the final record and records `VERIFIED` or `UNCERTAIN`. Lost mutation response is not blindly retried. `reconcile` only reads back and changes the ledger state; it never replays a mutation.
4. `lib/s04-routes.js`: authenticated HTTP `/v2/operations/preflight` (validation only), `/v2/operations/submit` (409 denied), `/v2/operations/reconcile` (409 denied), and `/v2/operations/:id` (owner-scope ledger status). Client-supplied permission claims do not enable mutations.
5. `index.js`: registers S04 routes **after S01 legacy guard and S03 authorization middleware**; updated checkpoint/version identification. Original S01-S03 restriction layers remain intact.
6. `package.json`: added `test:s04` and `check:s04` scripts; existing old test suites still run.
7. Added S04 tests covering persistence/restart-by-new-instance, forged plans, collision isolation, stale revisions, independent readback, uncertainty, safe reconciliation, route denial and source integration.

## Security and reliability invariants

- No legacy mutation route is re-enabled. Qdrant, Milvus and LanceDB direct unsafe legacy methods retain their S01 blocks. Native SillyTavern Standard endpoints are not changed.
- New mutation dispatch is **not connected** to public HTTP endpoints or real backend adapters. The mock-adapter engine tests demonstrate algorithmic behavior, not database safety or durability.
- S02 `RESERVED_NOT_ACTIVE` mappings **do not establish chat/lorebook ownership** or permission to write. S03 only authenticates a user-directory context; S05-S08 must supply authoritative source + physical backend attestations.
- `UNCERTAIN` never means a safe retry. Readback can confirm an outcome, but a stale/failed read must leave ambiguity explicit.
- The receipt's SHA-256 checksum detects accidental corruption; it is **not a cryptographic signature against a malicious actor with filesystem write access**. Host directory, permissions, mount and multi-process behavior require live review.
- Server storage/dispatch failures, disk exhaustion and process termination must be tested in the disposable real host before claiming durable recoverability. The ledger cannot itself make backend writes atomic.
- Actual old vectors, existing hashes and storage schema remain untouched. No migration or production data writes performed.

## New public API (registered beneath existing authenticated plugin router)

| Endpoint | Effect | S04 behavior |
|---|---|---|
| `POST /v2/operations/preflight` | Validate proposed payload, generate canonical IDs and fingerprints | **Non-vector-mutating; authorization NOT established** |
| `POST /v2/operations/submit` | Would execute a mutation | Always **409** `S04_MUTATION_NOT_ACTIVATED` |
| `POST /v2/operations/reconcile` | Would trigger a backend read | Always **409** `S04_RECONCILE_NOT_ACTIVATED` |
| `GET /v2/operations/:id` | Read a receipt under authenticated user's own vector root | Owner-bound; no vector mutation |

**Do not mistake an HTTP preflight 200 response for an authorized or executable operation.**

## Deferred work

- Host-authoritative source ownership/branch registration and verified active mapping; real backend adapter methods and revision/physical ID contracts.
- Cross-process, hostile concurrency, lost-response, independent reads, backend writes, and interrupted host acceptance on disposable databases.
- S05 authoritative scoped get/list/query/inventory, S06 Qdrant, S07 Milvus, S08 LanceDB/Vectra actual adapter implementation, S09 migration, S10 API stability and S11 VectHare reactivation.
