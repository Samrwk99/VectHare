# F10b.1 — Disposable local control-plane rehearsal runbook

**Use a disposable SillyTavern profile and disposable v2 collections.** Save existing deployments using an independent backup method before upgrading. This diagnostic is an administrator-only Node CLI, not a VectHare GUI restore button. Never run it on valuable data as your sole safety copy.

## Before running

1. Install the matched F10b.1 VectHare extension and Similharity plugin. Verify plugin/extension source fingerprint and version pin.
2. Ensure the trusted user-specific vectors directory is absolute, private (`0700` on Unix), nonsymlinked, and its `.similharity` directory already exists from the validated v2 installation. Confirm the correct authenticated `userScopeId` independently from the host; do not guess or supply a different user's scope.
3. Stop all cooperating writers. Inspect any existing `f09c10-writer-locks` entries. **Do not delete a lock** if found; investigate the associated mutation evidence. No pending S04/managed-record state should exist for the rehearsal.
4. Do not copy server credentials, embedding profiles, live chat sources or physical database files into the rehearsal area. This tool intentionally excludes them.

## Administration commands (example placeholders)

Run from the installed Similharity plugin directory. Substitute the trusted paths and user scope from your disposable host; do not paste real user IDs or secrets into shared logs.

```bash
node tools/f10b-admin-rehearsal.mjs --action capture --vectors-path /ABSOLUTE/PRIVATE/DISPOSABLE/VECTORS --user-scope-id DISPOSABLE_SCOPE --confirm DISPOSABLE_LOCAL_REHEARSAL_ONLY
node tools/f10b-admin-rehearsal.mjs --action verify --vectors-path /ABSOLUTE/PRIVATE/DISPOSABLE/VECTORS --user-scope-id DISPOSABLE_SCOPE --id CAPTURE_UUID --confirm DISPOSABLE_LOCAL_REHEARSAL_ONLY
node tools/f10b-admin-rehearsal.mjs --action rehearse --vectors-path /ABSOLUTE/PRIVATE/DISPOSABLE/VECTORS --user-scope-id DISPOSABLE_SCOPE --id CAPTURE_UUID --confirm DISPOSABLE_LOCAL_REHEARSAL_ONLY
```

The resulting `f10b-rehearsals` directory contains sensitive private receipt data. Staged copies have **no production authority**. Verify that live S02 mappings, operation receipts and managed tombstones did not change. Record only redacted capture UUID, operation result and environment information.

## Negative controls

- Introduce an in-flight writer lock **only in disposable data**; the capture must refuse.
- Introduce a pending/uncertain receipt and a pending managed registry entry in disposable state; the capture must refuse and retain evidence.
- Tamper with a staged or captured file; verification must refuse.
- Change the scope ID, insert a symlink, or remove the S02 map while leaving its initialization anchor; verification or capture must refuse.
- Restart the host; verify the previous captured evidence is still readable and still does not grant restoration rights.

## Outstanding F10b work

This is not a whole-database restore or disaster-recovery runbook. F10b still requires backend-specific consistent snapshots/exports, independent completeness checks, backed-up source identities, real host restarts and physical restore to **new** disposable backends, staged cutover/readback and rollback evidence. No production overwrite or uncertain-lock release is authorized by this stage.
