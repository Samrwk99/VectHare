# F10b.1 — Control-plane recovery rehearsal

Baseline: F09c.10 matched runtime, with F09c.11 offline decision-review handover. This is a **new F10b development increment**, not a completed full-backup or live-restore implementation.

## Implemented

- New `lib/f10b-recovery-rehearsal.js`: bounded, private, local control-plane snapshot and offline staging rehearsal, accessible to trusted administrative code only; no HTTP mutation/download routes.
- Captures checksum-verified S04 operation receipts, including exact operation plans and history; refuses pending (`PREPARED`, `SUBMITTED`, `UNCERTAIN`) receipts.
- Captures F09b.4 managed-record registry, retaining `DELETED` tombstones; refuses pending managed intentions.
- Captures validated S02 collection map and `initialized` anchor as a pair, where present; refuses anchor-without-registry and malformed mappings.
- Requires private, nonsymlinked host directories; rejects symlink/hardlink files, unknown entries, changed source scans, active or stale F09c.10 locks and in-progress registry writes.
- Performs two source scans and bounded SHA-256 file checks; persists a private manifest and bytes using exclusive file creation, fsync and restrictive permissions.
- Can verify the copied files and re-create them in a **fresh, automatically chosen private staging directory** without modifying source state; does not remove an uncertain lock or write to any vector backend.
- New administrator-only CLI `tools/f10b-admin-rehearsal.mjs`, requiring explicit local disposable-testing consent, user scope and trusted vectors directory.
- 15 focused tests cover snapshots, tampering, partial maps, pending operations, cross-user rejection and non-destructive staging.
- Updated extension/plugin version and S10 source fingerprint pin. Existing public routes remain unchanged.

## Deliberate boundaries

- **NOT** a whole-database or recoverable vector backup: no Qdrant, LanceDB, plugin Vectra or Milvus physical/vector data captured by this new module.
- **NOT** a production restore: no overwrite, cutover, credential export, automatic uncertain-operation reconciliation, stale lock takeover, or collection purge.
- Other F10 source-scoped evidence capture remains **non-authoritative** and is not promoted by F10b.1.
- A two-pass scan does **not** establish an atomic snapshot under concurrent activity; separate physical quiescence and actual host filesystem testing remain required.
- This private snapshot may contain sensitive receipt metadata: do not distribute it or use it as your only backup. SHA-256 detects accidental corruption but is not a signature against a user with write access to the archive.
