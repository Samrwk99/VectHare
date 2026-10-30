# F10b.3 — Disposable restoration staging (restricted)

Baseline: F10b.2 matched VectHare and Similharity packages.

## Implemented

- Added `lib/f10b3-disposable-restore.js` and administrator-only `tools/f10b3-admin-restore.mjs` to the Similharity package. No new server HTTP routes.
- Requires a validated, existing F10b.2 capture ID, explicit staging-specific confirmation, and two separate absolute private roots: backup and restore.
- Verifies the complete F10b.2 capture before creating output; checks names, file type, link counts, file sizes, and SHA-256 while copying; validates the copied inventory and rechecks original capture after the copy.
- Creates a new unpredictable `f10b3-<UUID>` destination with exclusive creation; refuses overlapping/symlink/unsafe roots and existing destination overwrite.
- LanceDB/Vectra: reconstructs file trees byte-for-byte into an inert, private `database` subdirectory. Does not open it through a native database SDK, install it as a live index, or claim semantic record-inventory agreement.
- Qdrant: safely stages the integrity-checked native snapshot archive as `snapshot.bin`. Does not call Qdrant collection recovery, upload snapshots, or create collections.
- Writes a local staging receipt explicitly marking `restoredIntoRunningBackend=false`, `sourceInventoryVerified=false`, and `productionCertified=false`.
- Read-only staged-data verification detects copied-data corruption, unexpected files, malformed receipt flags and symlinks.
- F10b.2's existing capture verification and the F09c cooperative-writer runtime remain unchanged.
- Updated plugin build identity, source manifest and VectHare fingerprint pin.

## Explicitly not implemented

No Qdrant online recovery, native LanceDB/Vectra SDK reopen, semantic vector/metadata inventory comparison, Milvus native backup/restore, combined control-plane/vector recovery cut, rollback of live databases, or automatic activation/cleanup. No production permissions were granted.

A staged directory is a **rehearsal artifact**, not a verified recoverable database. Integrity hashes check accidental alteration; they do not authenticate an attacker-controlled backup and manifest.
