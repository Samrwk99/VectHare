# VectHare — Phase 0 implementation checklist

Build base: user-uploaded `VectHare(4).zip`; existing I01–I18 fixes preserved. Original planned source label `VectHare-I18-Fixed.zip` was superseded by the actual supplied archive. Baseline sha256: `2b59de6aa7036c5e18caee672735dab68271b33b8185cddb86de6e84c543aa03`.

**Status:** Phase 0 safeguards are **locally implemented and test-verified**; real server contract verification remains blocked. In particular, *not* production-certified for destructive backend operations. Do **not** interpret a blocked destructive operation as proof that the backend is empty or that data has been purged. The local tests exercise conservative refusal and deterministic fake-backend behavior only.

| Task (plan order) | Local implementation | Evidence / verification | Blockers / status |
|---|---|---|---|
| **P0-10** backend contract verification | Client request survey, four version-aware contract fixtures and capability ledger (`tests/contracts/*`, `utils/backend-contracts.js`); all unproven capabilities declared `unknown` | P0 contract fixture assertions; unknowns fail-closed | **External verification blocked**: deployed SillyTavern / Similharity server commit/version, source and disposable live test environment not included. No certified purge ACK, complete inventory, tenant filter, getByIds or write count. |
| **P0-2** collection identities | `utils/collection-keys.js` + compatibility exports in `core/collection-ids.js`; backend:source:ID with colons preserved; ambiguous/legacy IDs fail resolution | P0 round-trip, multiple-backend collision and invalid-input tests; deletion sites use resolver | **Local implemented**. No registry migration. |
| **P0-1** fault-injection harness | Deterministic `tests/helpers/fake-backend.js`, separate tenant-keyed data, lost-ACK, partial acceptance, readback error, rejection, delete fault, and delayed operation integration | `npm run test:p0` including cross-tenant scenario | **Local implemented**. Fake server results do not prove production APIs. |
| **P0-4** response validation | `utils/backend-operation-validation.js`; explicit confirmed/failed/uncertain/unsupported and count checks; no generic HTTP 200 success assumption | P0 200/success:false, 500, partial counts, malformed/no ACK, missing items tests | **Local implemented**. Unverified adapter ACKs do not authorize deletion. |
| **P0-12** operation outcomes | `utils/operation-outcomes.js`; unique IDs, once-only settling, uncertain follow-up block, bounded redacted allowlisted events; write API returns reconciliation marker for unverified writes | P0 late-ACK and secret event tests | **Local implemented**. In-memory only; durable journal belongs C02. |
| **P0-11** safe rollout | `utils/phase0-rollout.js`, `core/constants.js`; `verboseOperationEvents=false` defaults off, code-only, counts omitted unless explicitly enabled. Optional flag cannot change destructive invariant. Snapshot helper for later migration. Manifest version retained `2.2.0-alpha`. | P0 defaults/snapshot tests, I01 fail-closed cases | **Local implemented**. No migration; restore prior build from user's source ZIP if necessary. |
| **P0-9** write synchronization | `utils/keyed-mutex.js` promise-queue with AbortSignal; admission/drain barrier in core insert, delete and global-purge pathways; lock around loader deletion evidence | P0 concurrent locks, three-waiter cancellation FIFO, abort-during-callback, throwing-holder cancellation, timeouts, uncertain write, global-purge interleaving | **Local implemented** in-tab only. Multi-tab/distributed/late-server-commit recovery is C02/C03. |
| **P0-3** destructive gates | `core/destructive-safety.js` guard, qualified delete in loader, blocked unverified purge, overwrite-import rejection, no raw UI Qdrant purge, preserved metadata/registry, incomplete inventories block cleanup | P0 invalid/legacy owner, tenant mismatch, capped/unknown inventory, missing metadata, global purge no-send tests; I01 regression | **Local implemented / protected by refusal**. Actual collection deletion unavailable until backend proofs; C01/C11. |
| **P0-5** safe replacements | `utils/replacement-safety.js` insert-readback-set-difference-delete workflow; chat reverse-sync/repair defer unverified cleanup; duplicate-hash production fixer refuses unprovable delete-before-insert; Content Vectorizer Replace All stops after failed purge | P0 successful, lost-ACK, partial, cancelled, delete failure, two-tenant fixtures; I03 regressions | **Local implemented / destructive repair deferred**. Full record-ID-based repairs await C02/C06/C11. |
| **P0-6** redaction | `utils/security.js` recursive redaction, operation-event sink, JSON export, clipboard diagnostic reports; request credentials untouched | P0 mixed-case keys, nested/array, auth string, URL credentials, circulars, error and sentinel tests | **Local implemented for modified sinks**. Not equivalent to server-side secret storage; C05. |
| **P0-7** unsupported modes | `utils/feature-support.js`, strategy UI/runtime gates, chunker rejection, emotion embedding-similarity block; legacy saved unsupported choices preserved but not silently executed | P0 mode matrix and runtime rejection; I17 cache regression | **Local implemented**. Adaptive grouping/scene upload parsing and similarity classifier remain C13/C14. |
| **P0-8** 11 quick fixes | #106 swipe reverse-sync; #118 bounded Base64; #119 safe PNG parser; #73 message role; #80 speaker lookback; #42 tenant stats marked unavailable when filter unverified; #101 incompatible vector path; #167/#18 canonical parsing in diagnostics; #47 repair status; #120 multi-import override blocked | P0 source-level linkage and direct behavior tests, I01–I18 cumulative suite | **Local fix/revalidation complete**. #42 returns unavailable pending verification; #47 does not claim destructive repair complete; existing fixes retained where applicable. |

## Flag register and rollback

| Flag | Default | Optional behavior | Safe fallback |
|---|---|---|---|
| `verboseOperationEvents` | `false` | Includes numeric allowlisted accepted/deleted/expected counts in in-memory operation event summaries | Count-free ID/status/reason records; operation status enforcement is unchanged |

The flag is a code-level build default; no new settings key is persisted. There is no schema/registry migration and `manifest.json` remains at `2.2.0-alpha`. Roll back by restoring the exact uploaded ZIP and original extension settings backup. Do **not** roll back to a build permitting unverified deletion without separately reconciling pending writes and backing up collections. The registry snapshot helper is non-persisting and for future versioned migrations only.

## Exit gates

- [x] Original source preserved, patch applied cumulatively, no planned C01–C14 implementation claimed.
- [x] `npm run test:repair` — **199/199 passed**.
- [x] `npm run test:p0` — **33/33 passed** (local mock and static/specific checks).
- [x] Added negative integration scenario with A/B qualified collections, A uncertain insertion, incomplete inventory and blocked purge.
- [x] Safe failure when real server ownership, scopes, acknowledgements and inventory are unknown.
- [ ] Live disposable server smoke tests (Standard and at least one Similharity backend) — **not run; unavailable**.
- [ ] Pinned server-side contract verification for all four adapters — **blocked**.
- [x] Build ZIP syntactic and archive integrity checks — see companion verification report.

## C01 handoff / remaining Phase 2 work

C01–C14, including all 117 Phase 2 findings, remain open. Before re-enabling destructive cleanup on any backend, pin deployed SillyTavern + Similharity versions, prove tenant isolation and authoritative *complete* inventory and deletion ACKs, implement tombstone/recovery semantics, and run disposable-data server smoke tests. Unknown means *blocked*, not false or empty. C01 is next, but do not treat the locally passing Phase 0 mock suite as live backend certification.

## P0-9 corrective checkpoint (post-Phase 0)

- [x] Reproduced cancellation-ordering failure in the initial Phase 0 delivery.
- [x] Fixed premature queue-slot release while predecessor is still active.
- [x] Preserved prompt rejection for queued aborted callers without exposing the lock to followers.
- [x] Added tests for aborted middle waiter, active-callback abort, and throwing holder.
- [x] `npm run test:p0`: **33/33 PASS**; `npm run test:repair`: **199/199 PASS**; JS syntax check **PASS**.
- [ ] Real server contract, tenant ownership and full inventory verification: **still blocked** pending pinned deployed versions. These are C01/C06/C11 prerequisites, not results of this mutex fix.
