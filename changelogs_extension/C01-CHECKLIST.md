# VectHare C01 checkpoint checklist

| Requirement | Status | Evidence or blocker |
|---|---|---|
| #158 Preserve same-hash records across tenants | LOCAL PASS | `utils/c01-inventory.js`, scoped chunk metadata API, fake two-tenant tests |
| #158 Refuse orphan cleanup with unproven owners | LOCAL PASS | `mayRemoveLegacyHashMetadata`; diagnostics `fixOrphanedMetadata` fails closed; global hash-only deletes refused |
| #158 All existing metadata is migrated to scoped keys | OPEN (C04) | Legacy reads/writes remain; no silent migration without verified record identity |
| #158 Destructive production diagnostics run only on created test namespaces | LOCAL PASS / LIVE BLOCKED | Generated `vh:test:*` IDs, scoped purge guard; storage test skipped when cleanup proofs absent |
| #189 Authoritative paginated collection/record inventory | MOCK-TESTED / LIVE BLOCKED | Positive end, tenant scope, cursor cap, count checks; pinned adapter pagination not provided |
| #189 Browser orphan cleanup cannot delete from partial UI list | LOCAL PASS | Removed `refreshCollections()` cleanup; old cleanup API now requires authoritative evidence |
| #216 Tombstone/recovery state and ordering | MOCK-TESTED / LIVE BLOCKED | Coordinator uses prepared → purge-sent → purged → finalized → completed; 35 C01 tests total |
| #216 Purge ACK + verified empty post-purge | MOCK-TESTED / LIVE BLOCKED | Fake positive acknowledgements; live ACKs and readback unverified |
| #216 Settings tombstone durability | OPEN | Debounced ST settings save cannot acknowledge durability; live runtime refuses purge |
| #216 Recovery at startup | LOCAL PASS FOR DETECTION | Warns on pending tombstones; automatic replay disabled without backend proof |
| #216 Optional protected export-before-delete | MOCK-TESTED / UI OPEN | Pure coordinator requires verified export for protected flag; production UI/export receipt remains open |
| #220 Explicit available / unavailable / unknown | LOCAL PASS | Standard fallback, `getSavedHashes` metadataStatus, `metadataEvidence` |
| #220 Real backend metadata capability known | LIVE BLOCKED | P0 contract fixtures unknown; no pinned server |
| Baseline P0-9 mutex retained | PASS | 33/33 P0 tests |
| Baseline I01–I18 retained | PASS | 199/199 repair tests |
| No destructive live action on unverified server | PASS BY REFUSAL | Direct purge and global-purge extra gates unknown; all live C01 deletion blocked |

**Verdict:** C01 safety foundation delivered and regression-tested; **full C01 acceptance is pending external server/persistence verification and staged C04/C06/C11 dependencies.** This release does not authorize destructive production operations.
