# C07 — foundation checkpoint checklist

Status refers to **local extension work only**, not full C07 acceptance.

| Original issue | Foundation status | What remains for full acceptance |
|---|---|---|
| #111 positional metadata refresh | Prepared | `reconcilePositions` proposes corrected indices; verified `updatePayload` or opt-in C02 replacement needed |
| #110 scene stable IDs | Implemented locally for newly anchored scenes | Real host chat reload/branch/copy and migration of legacy scenes |
| #112 speaker identity | Partial | Speaker names preserved in metadata; embed-text and affected vector ID migration deferred |
| #207 hash-only joins | Partial | Duplicate list rows are ambiguous rather than silently joined; other join sites need ID-aware inventory |
| #87 stable record identities | Foundation implemented | Logical collection-qualified IDs and duplicate handling; no physical backend/client ID migration |
| #90 versioned fingerprints | Partial | Versioned content fingerprint; legacy configuration fingerprint migration/revalidation not implemented |
| #86 dependent rehash remaps | Prepared | `remapReferences` returns safe plan; C02 transaction/actual UI call sites pending |
| #39 linked/parent remaps | Prepared | Strict parent/link/summary remap helper; backup/import activation pending |
| #45 unverified configuration | Still blocked | Existing legacy config check requires explicit versioned migration; no fail-open assumption of certification |
| #98 attachment identity parity | Preserved | Existing raw-text attachment policy unchanged; real host attachment tests required |
| #102 grouped memberships | Partial | Message UID membership recorded and same-text duplicates combined; downstream contextual matching pending |
| #138 World Info entryUid | Implemented locally | Real lorebook integration smoke tests |
| #184 diagnostic fates | Implemented locally | Initial search isolates collection record fates, ambiguous later fate is unresolved; other UI consumers require coverage |
| #177 duplicate diagnostics | Partial | Collision helper and duplicate-list ambiguity implemented; comprehensive stored-content audit requires inventory |

## Exit checks
- [x] Preserve earlier I01–I18, Phase 0, C01, C04/C06/C11 A/B and C03 regression suites.
- [x] Added 40 C07-specific identity and integration tests.
- [x] Physical backend storage keys and plugin source not changed.
- [x] Preserve fail-closed C01 purge restrictions.
- [x] Run syntax and ZIP tests.
- [ ] Verify actual SillyTavern `getContext().saveChat()` behavior, durability, and event order.
- [ ] Verify external backend identity/upsert/updatePayload semantics and complete inventory.
- [ ] C02 durable replacement/rehash journal, reference remap and recovery.
- [ ] Live testing of chat edits, branches, swipes, imports, scenes, and same-hash records on each backend.

**Release classification:** C07 identity foundations locally implemented and tested; C07 as a complete 14-issue repair group remains **partial**.
