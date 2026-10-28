# VectHare — C02 verification report

Date: 2026-10-27. Tests run from the unpacked final cumulative extension sources in Node. Plugin reference ZIP not modified. This is **local test verification, not live server certification**.

| Suite | Passed | Failed |
|---|---:|---:|
| I01–I18 | 199 | 0 |
| Phase 0 | 33 | 0 |
| C01 | 50 | 0 |
| C04/C06/C11 Stage A | 24 | 0 |
| C04/C06/C11 Stage B | 31 | 0 |
| C03 | 38 | 0 |
| C07 foundations | 40 | 0 |
| Read-only plugin contract fixtures | 2 | 0 |
| C02 coordinator, journal, fault injection | 50 | 0 |
| C02 integration | 11 | 0 |
| **Total** | **478** | **0** |

Syntax: `node --check` on every `.js` and `.mjs` in release, zero failures.

## Critical fault cases covered

- Unacknowledged insert that committed all records; re-list shows complete, so no duplicate retry.
- Lost ACK after partial commit; old items retained, missing IDs reported, one-shot manual resume only with verified idempotency and unchanged per-item fingerprints.
- No count or ownership proof; no deletion and no successful import activation.
- Lost delete acknowledgement; recovery does not issue another blind delete.
- Same-ID replacement, old-minus-new difference, post-delete proof, missing new record during readback, malformed response.
- Cancellation before dispatch and after server write; queue ordering and unrelated-collection concurrent writes.
- IndexedDB simulated restart, schema rejection, unique journal ID, rollback of committed checkpoint refused.
- Real import module with unverified response cannot register collection or enable imported metadata.
- Source integration for both chunk editors, scene creation, scene split, startup journal warning and non-idempotent insert paths.

## Remaining limitations

The server-side plugin source reports inserted count after handler completion, but this is not a durable, tenant-scoped proof of committed storage and does not supply the complete paginated inventory and readback required to support atomic replacement. None of the test outcomes certify deployed-plugin version, actual host save durability, cross-tab synchronization, physical record collision migration or distributed transactions. Those requirements remain blocked; C01 destructive operations remain closed.
