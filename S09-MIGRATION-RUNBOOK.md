# S09 migration and compatibility runbook

**Status:** source implementation plus offline fixtures; no real backend migration, activated mapping or production cutover.

## Inputs

The S09 planner accepts an explicit local JSON object with `backend`, canonical `embedding`, `records`, and `ownerMappings`. Each legacy record must have a physical name, unsigned decimal legacy hash and chosen stable v2 UUID `recordId`. Owner mappings must be recorded separately with matching legacy locators, canonical scope (`userScopeId`, `collectionId`, `type`, `sourceId`, optionally `branchId`) and a nonempty evidence reference. A human-entered evidence reference is **not authoritative ownership proof**. The planner never promotes it to a trusted owner.

Reference relations should be supplied as `records[].references` arrays of `{legacyPhysicalName, legacyHash}`. Omitted reference graphs cannot be independently verified. Hidden metadata links still require a separate VectHare migration adapter, which is not implemented in S09.

## Read-only plan

```sh
node tools/s09-plan.mjs /path/to/disposable-inventory.json
```

Output contains only record identifiers, map digests, source fingerprints and quarantine reasons, not full memory text or vectors. It always sets `cutoverAllowed: false`, `backupVerified: false`, `snapshotConsistency: UNPROVEN`. Missing ownership, ambiguous collection names, duplicate legacy locators, target collisions, dangling or cross-user references cause quarantine. Exit status 3 means the planner found unresolved records or owner mappings; status 1 means invalid input.

## Disposable fixture rehearsal only

Make a **new empty private directory (mode 0700)**, ideally in a temporary test workspace. Supply only deliberately disposable synthetic records with `text`, Float32-representable `vector`, `metadata` and required identity fields.

```sh
mkdir -m 700 /tmp/s09-disposable-fixture
node tools/s09-fixture-rehearsal.mjs /path/to/disposable-inventory.json /tmp/s09-disposable-fixture --disposable
```

The rehearsal rejects nonempty destinations, symlinks and unresolved records. It writes a backup of the supplied fixture, a staged v2 representation, and checksums/digests. It independently reads staged files and produces a receipt that **explicitly denies** production migration, server ownership attestation and cutover. `rollbackFixtureSession()` in `lib/s09-fixture.js` renames the simulated staged file while retaining the backup; it never touches database collections. These are file-integrity checks, **not** proof of real database snapshot integrity or durability.

## Gate for a real migration (not satisfied by S09)

1. Pin and verify running SillyTavern, installed plugin, backend versions and configured auth.
2. Read each tenant/source/branch mapping from authenticated host state, not from memory metadata. Resolve copied-chat branch IDs and all scene/lore/chunk relationships.
3. Prove a complete, stable legacy inventory with authoritative backend identity, including >1,050 records, duplicate/collision discovery and error propagation.
4. Establish actual write quiescence or backend-supported consistent snapshots, with a durable verified backup and tested restore.
5. Implement backend-specific staging/provisioning using pinned SDKs. Never drop, purge or overwrite source collections.
6. Copy to distinct physical v2 targets with independently verified counts, ownership, text, vector, metadata and links; resolve quarantine before cutover.
7. Require independently authorized cutover, stable registry/alias transitions, source retention and a tested rollback path.
8. Run disposable end-to-end acceptance twice, including after restart. All public writes and verified exports stay blocked until then.

**S09 deliberately has no production migration/cutover HTTP endpoint.** A syntactically valid mapping or successful local fixture rehearsal must never be treated as permission to migrate real records.
