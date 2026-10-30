# VectHare M3 — implementation changelog (Qdrant reference)

Baseline: `VectHare-M2.zip` + `Similharity-M2.zip`. Versions: VectHare `2.2.0-alpha.m3.1`, Similharity `3.2.10-m3.1`.

## Implemented

- Added `lib/m3-collections.js`: narrow source-attested Qdrant collection preview, full unfiltered physical inventory including vectors and payload, exact owner validation, duplicate/partial-scan refusal, exclusive-owner check, schema and keyword-index attestation.
- Added durable, private, checksummed M3 backup/operation store at server-owned `.similharity/m3-lifecycle`, with atomic exclusive creation, fsync, one-way operation claims, ownership checking and backup digest/integrity verification. Backups include vector rows, raw scoped payloads, managed-record registry snapshot, source fingerprint, embedding contract and S04 operation-ledger checkpoint. Backups do not include original SillyTavern chat files or credentials.
- Added conservative backup capture through the F09c.10 physical cooperative writer boundary, refusing active M2 job leases, managed WRITE_PENDING/DELETE_PENDING states, unsettled S04 operation receipts, changed saved-source snapshots, changed registry and changed inventories.
- Added destructive operation *plans* for `restore`, `delete`, `empty`, `rebuild` requiring a previously verified, current backup with matching inventory/managed registry/ledger. Additionally requires the entire physical inventory to be fully accounted for in the active managed record registry and saved v2 provenance.
- Added internal **disposable-only** fresh-Qdrant restore staging prototype: new server-generated collection name, freshness check, schema/index provisioning, bounded point replay, exact post-restore inventory comparison, source collection untouched. Not exposed as a public production restore route.
- Added the read-only/preflight HTTP endpoints `/v2/m3/collections/preview`, `/v2/m3/backups/create`, `/v2/m3/backups/:backupId/verify`, `/v2/m3/collections/plan`; `/v2/m3/collections/execute` always refuses production physical mutation.
- Added `utils/m3-collections-gui.js` and an M3 collection-management section in VectHare settings: physical-inventory preview, explicit backup capture, backup verification, and action planning with visibly blocked cutover/deletion/rebuild. Added exact E02 browser request allowlist and negative injection tests.
- Updated route-inventory classifications, plugin index registration, package versions, S10 self-integrity manifest, test harness mocks.

## Explicitly NOT delivered (no misleading ENABLED status)

- Production restore-to-fresh through S04/F09c.10 and proof of full roundtrip on a live Qdrant backend.
- Coordinated S02/F02/S05/S04/F03 cutover/rollback support for a different physical name. The existing canonical physical-name invariant remains intact, deliberately.
- Physical owned-collection delete or empty/re-provision; mandatory backup, atomic lifecycle tombstone, authoritative postdelete readback and uncertain-operation quarantine still need integration.
- Re-embedding under a new embedding profile and managed rebuild with cutover and rollback.
- Latest-stable disposable SillyTavern + real Qdrant certification, including the carried M0/M1/M2 gates.

**M3 classification:** meaningful preflight and logical-backup implementation delivered; M3 milestone itself remains INCOMPLETE. Continue M3 before declaring M4 the next sequential milestone. No unrestricted purge.
