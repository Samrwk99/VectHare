# C07 Foundations — verification report

Date: 2026-10-27. Verification: local Node test harness only (no SillyTavern runtime, deployed plugin or live backend tests).

| Test suite | Passed | Failed |
|---|---:|---:|
| I01–I18 `npm run test:repair` | 199 | 0 |
| Phase 0 `npm run test:p0` | 33 | 0 |
| C01 `npm run test:c01` | 50 | 0 |
| C04/C06/C11 Stage A `npm run test:dependencies` | 24 | 0 |
| C04/C06/C11 Stage B `npm run test:dependency-b` | 31 | 0 |
| C03 `npm run test:c03` | 38 | 0 |
| Plugin read-only contract test | 2 | 0 |
| C07 `npm run test:c07` | 40 | 0 |
| **Total** | **417** | **0** |

Additional checks: every `.js`/`.mjs` passes `node --check`; ZIP file integrity verification and SHA-256 manifest accompany the package.

## New adversarial scenarios

- Hash 33 stored under two collections must produce different logical records.
- Local record identity cannot be created from a bare, unverified collection name.
- Escaped IDs and future-proof versioned, stable, Unicode fingerprint on a plain HTTP host.
- A copied chat with the same UID has a different chat-qualified reference.
- Duplicate message UIDs in a single chat are re-stamped; rejected or unavailable save cannot confer durability.
- A completed save followed by a stale job does not roll back a potentially persisted UID.
- Grouping the same raw text preserves two message memberships as one hash-backed storage record.
- Two different raw strings forced to the same hash abort the grouping operation.
- Position reconciliation follows message UIDs after insertion and refuses missing/duplicated members.
- Parent/summary/link remap refuses unresolved or invalid replacement mappings without partial mutation.
- Anchored scene markers follow their saved messages, reject copied-chat references, reversed anchors and duplicate UIDs.
- Search diagnostics never merge two simultaneously returned same-hash fates from different collections.
- Metadata joins explicitly detect ambiguous duplicate stored hashes.

## Not certified

- No actual server/client durability guarantee from host `saveChat()`; it is an attempted save, not an external committed receipt.
- No full inventory-proof collision audit against already-stored records.
- No backend physical record migration, automatic link repair or transaction journal until C02 and contract evidence.
- No activation of live destructive deletion or purge.
