# F10b.2 — Disposable physical-backup host runbook

**Never run against your existing valuable vectors.** Use a disposable SillyTavern profile, uniquely named newly provisioned F09c fixtures and a separate private (0700) backup directory. Install the matched extension/plugin; back up your ordinary deployment independently first. The F10b.2 CLI is administrative only; it does not add browser routes.

**Prerequisites:** Node >=18; reliable private local filesystem; known-good F09c cooperating writer-lock directory; only test data; no pending/uncertain mutation locks. For LanceDB/Vectra, stop chat writes and any background index modification, confirm the index is quiescent, then invoke with `--quiescence-confirmed YES`. Independently check that the data really is the F09c disposable source. The tool rejects other names.

## CLI examples

From the `VectHare-Similharity` plugin root, replace the sample paths and fixture identifiers with *new disposable fixtures you created*:

```
node tools/f10b2-admin-backup.mjs --action capture --backend lancedb --disposable-name vh_f09c7_disposable_<32-lowercase-hex> --disposable-parent /private/disposable-lance --backup-root /private/f10b2-backups --quiescence-confirmed YES --confirm F10B2_I_CONFIRM_DISPOSABLE_BACKUP_ONLY

node tools/f10b2-admin-backup.mjs --action capture --backend vectra --disposable-name vh_f09c8_disposable_<32-lowercase-hex> --disposable-parent /private/disposable-vectra --backup-root /private/f10b2-backups --quiescence-confirmed YES --confirm F10B2_I_CONFIRM_DISPOSABLE_BACKUP_ONLY

node tools/f10b2-admin-backup.mjs --action capture --backend qdrant --disposable-name vh_f09c6_disposable_<32-lowercase-hex> --endpoint http://127.0.0.1:6333/ --backup-root /private/f10b2-backups --confirm F10B2_I_CONFIRM_DISPOSABLE_BACKUP_ONLY

node tools/f10b2-admin-backup.mjs --action verify --backup-root /private/f10b2-backups --id <uuid-from-capture>

node tools/f10b2-admin-backup.mjs --action milvus-status
```

If Qdrant requires authentication, set `F10B2_QDRANT_API_KEY` securely in the CLI process environment; never include it in arguments or exported logs. Do not run on remote servers, production collections, active locks, or mixed-version/unverified SDK deployments. The native Qdrant server snapshot created by POST is not deleted automatically; record and manually review its location, disk usage and permissions.

## Required acceptance evidence

1. Verify fixture identity and no valuable data. Record backend/OS/SDK/version and redacted command line.
2. Verify source file tree or native collection counts using *backend-specific* tools before capture. Preserve raw evidence privately.
3. Capture only after explicit consent; verify returned SHA-256 file manifest and exact bytes.
4. Corrupt a copy and verify the tool refuses its checksum. Test symlink refusal, an active cooperating writer lock, interrupted capture, size limits and missing directory.
5. Stop/restart the service and examine native snapshot/physical file consistency on your host; a file hash alone cannot prove this.
6. Do not restore yet: F10b.3 must add disposable restore and full vector+metadata inventory readback. Never place captured bytes over live folders.
7. Treat Milvus as **not backed up** until official Milvus Backup with correct object storage and version support has been integrated and tested.

**Hard fail:** any path to production data, secret leakage, corrupted archive accepted, incomplete snapshot described as complete, unexpected collection modification/deletion, or silent retry after an uncertain result.
