# VectHare — C03 issue checklist (38 new tests)

**Scope:** 14 issue references (four pre-existing dependent issues and ten mechanisms). This is an **extension-side development checkpoint**, not an attestation of deployed SillyTavern or backend compatibility.

| Issue | Local checkpoint | Evidence | Outstanding acceptance limitation |
|---|---|---|---|
| #31 — immutable run/chat identity | Implemented | Frozen `JobContext`, integrity UUID prioritization, stale-identity tests | Rename/branch/import must be checked in actual host |
| #32 — repair bound to chat and collection | Implemented locally | Repair-created job, checks following async reads, signal-aware insert and verification | Unknown insert acceptance needs C02 proof |
| #51 — generation/chat validation before injection | Implemented locally | Generation token + post-await guards; delayed-query race tests | Confirm all host generation event orderings |
| #91 — in-flight writes and late results | Partially completed | Tracked promises, pre-transport markers, late ACK and timeout tests | Persistent C02 journal/real server reconciliation missing |
| #218 — purge vs active writes | Partially completed | Admission close, cancellation, all-settled writes, blocked-uncertain tests | C01 deletion and verified plugin purge contracts still blocked |
| #49 — per-collection synchronization | Implemented | Existing P0 mutex; concurrent, cancel-middle, independent-key tests | Only in-tab, not distributed cross-tab locking |
| #92 — abort queued work | Implemented | Core insert/delete lock receives AbortSignal; negative cancellation tests | Server may still commit already-dispatched calls |
| #75 — activation history scope | Partially completed | Chat/collection/scope partition, session reset, shared-hash isolation tests | Persistent conversation counts and full C08 frequency model missing |
| #27 — operation-specific controllers | Implemented for chat jobs | Per-job signal, one-job-only cancellation, signal composition with manual Stop | Some legacy non-chat workflows still use global pause/stop UI |
| #21 — lifecycle, cleanup, pending marker | Partially completed | Init guard, event registry, pagehide teardown, startup marker tests | No automatic server reconciliation; localStorage availability required for persistence |
| #1 — stale sync on chat switch | Implemented locally | Job-bound sync; invalidated queued events and late-write tests | Host chat lifecycle validation remains |
| #106 — swipe reverse-sync | Previously completed in Phase 0 | `MESSAGE_SWIPED` immediate reverse-sync hook preserved | Real host event check |
| #12 — stale resume | Implemented | Identity + request-version guards, existing I03 tests | Real host testing pending |
| #81 — stale scene cache | Implemented | Versioned scene reads, identity guard, late-read race test | Real UI/scene smoke test pending |

## Exit checks

- [x] Preserve the exact previous cumulative code baseline, apart from intended C03 modifications.
- [x] Preserve P0-9 mutex correction and C01 fail-closed delete controls.
- [x] No Similharity plugin modifications.
- [x] I01–I18, Phase 0, C01, C04/C06/C11-A/B suites pass.
- [x] C03 dedicated race/fault suite passes (38/38).
- [x] JS syntax and archive integrity pass.
- [ ] Run actual host event, chat-rename, branch, import, and reload smoke tests.
- [ ] Reconcile and verify browser-local uncertain markers against server evidence (C02).
- [ ] Verify deployed plugin contracts and durable settings checkpoint (C01/C06/C11).
- [ ] Enable safe live purge only after server-backed deletion acceptance.

**Release decision:** C03 extension-side job foundation is implemented and locally regression-tested. C03 live/end-to-end acceptance is **not yet complete**, and destructive purge remains disabled.
