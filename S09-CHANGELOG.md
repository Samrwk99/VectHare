# S09 — Migration and compatibility implementation

**Baseline:** S08 cumulative ZIP. **New version:** `3.2.9-s09.0`. **VectHare modified:** No.

## Added

- `lib/s09-manifest.js`: deterministic read-only migration candidates with SHA-256 integrity digest, canonical S02 UUID/collection mapping, strict numeric legacy locators, separate operator owner-mapping evidence references, collision quarantine and explicit refusal of cross-user or dangling relationships. Never grants ownership or cutover.
- `lib/s09-fixture.js`: isolated local-file backup/stage/readback/rollback rehearsal. Converts complete synthetic fixture payloads to v2 identity, hash, revision, text, metadata and vector shape. Requires a new private empty directory and explicit disposable opt-in. No backend calls, schema provisioning, registry activation or production rollback.
- `tools/s09-plan.mjs`: read-only migration manifest CLI.
- `tools/s09-fixture-rehearsal.mjs`: disposable fixture rehearsal CLI.
- `tests/s09-migration.test.mjs`: regression coverage for duplicated identifiers, branches, owner mapping conflicts, references, data integrity, fixture refusal and staging/rollback.
- `S09-MIGRATION-RUNBOOK.md`: operator schema, CLI usage and unmet production gates.

## Preserved

- S01 legacy insert/update/delete/purge HTTP blocks; S02 reserved-only registry; S03 private configuration and conservative reads; S04–S08 internal, disposable-only backend adapters.
- Original legacy records, source ZIP, VectHare extension and existing registry status remain unchanged.

## Important limitations

Owner evidence references are not server-attested; no live backend snapshot, backup, copy, restore or cutover was performed. There is no production migration executable because trusted chat/source/branch grants, complete legacy inventory, native SDK staging, and concurrency/snapshot guarantees are not established. The fixture simulates migration behavior on disposable local JSON data only.
