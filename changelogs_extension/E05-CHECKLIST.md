# E05 — Acceptance checklist and capability verdict

## Locally implemented and verified
- [x] Read actual E04 Standard and LanceDB adapters and plugin source (`index.js`, `lancedb-backend.js`), without changing Similharity.
- [x] Validate collection identity and refuse lossy sanitized LanceDB names for new candidate writes.
- [x] Validate unique hashes, non-empty text, finite precomputed vectors, same dimension, batch size limits.
- [x] Verify backend inventory using explicit pages, stable count, duplicate detection, end marker and repeated sweep.
- [x] Compare independent readback, including vector and metadata, rather than HTTP success/echoed counts.
- [x] Implement a journal/readback/lock-based insert primitive that refuses unproven contracts; uncertainty requires reconciliation, no automatic retries.
- [x] Correct LanceDB single-page hash inventory truncation risk (now fails closed on oversized/unprovable results).
- [x] Create a disposable-only local probe executable. No purge.
- [x] Extend VM fixtures and offline regressions without changing protective runtime policies.
- [x] All E01–E04 static checks preserved.

## NOT COMPLETE — live host probe and deployment acceptance
- [ ] Start a **disposable** SillyTavern installation with this exact Similharity revision.
- [ ] Independently verify installed plugin file hashes and authenticated host user identity.
- [ ] Run Standard/Vectra plugin route probe P6/P8 twice, including one pass after a server restart.
- [ ] Run LanceDB plugin route probe P6/P8 twice, including one pass after a server restart.
- [ ] Probe duplicate same-hash inserts and whether LanceDB append produces extra rows, strictly in disposable collections.
- [ ] Probe 1,050+ records with complete pagination and consistency/count checks for both backend paths (P7).
- [ ] Verify Standard **native** vector endpoints separately against the running SillyTavern revision.
- [ ] Verify real Vectra/LanceDB embedding dimensions, metadata and vector readback, count, failed delete propagation and persistent restart behavior.
- [ ] Verify multi-user LanceDB base path isolation and collection-name collision handling.
- [ ] Integrate verified-write primitive with actual C02 journal, host settings acknowledgements, Web Locks and collision inventory; test cancellation and uncertain restarts live.
- [ ] Repeat after a server restart, with a second distinct evidence receipt, and have a human review both.
- [ ] Unlock individual E02 Standard/LanceDB operation cells *only* after verified acceptance. No blanket backend unlock.
- [ ] Test normal user flow: vectorize → retrieve → modify → reindex → export, with disposable real data.

## Runtime status after E05

| Backend | Insert | Targeted delete | Replace/edit | Global purge | Read/list |
|---|---|---|---|---|---|
| Standard | UNPROBED / blocked | UNPROBED / blocked | Blocked | DENIED | Native/plugin read contracts still need host verification |
| LanceDB | UNPROBED / blocked | UNPROBED / blocked | Blocked | DENIED | Two-sweep bounded inventory; not live-certified |
| Qdrant | DENIED | DENIED | DENIED | DENIED | Prior E04 guarded reads only |
| Milvus | DENIED | DENIED | DENIED | DENIED | Prior E04 guarded reads only |

**E05 code-preparation checkpoint complete locally. E05 operational write activation NOT complete. Do not market this as a user-ready release.**
