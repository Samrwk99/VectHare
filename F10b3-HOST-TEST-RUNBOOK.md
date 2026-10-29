# F10b.3 — Disposable host rehearsal runbook

**Not for valuable databases. No live restore action in this checkpoint.** Use a separate, disposable SillyTavern profile and the matched F10b.3 extension/plugin packages.

1. Create two **different, private, empty directories** owned by the administrator for backup artifacts and restore staging. On Unix, make them mode `0700`. They must not be nested inside each other and must not be located under a live collection.
2. Obtain a validated F10b.2 capture of a *new F09c disposable* Qdrant, LanceDB or Vectra fixture using the F10b.2 administrator tool and its exact consent. Confirm `verify` passes. Milvus capture is not supported.
3. From the plugin directory, run:

   ```bash
   node tools/f10b3-admin-restore.mjs \
     --action stage \
     --backup-root /private/backup \
     --restore-root /private/staging \
     --capture-id <capture-uuid> \
     --confirm F10B3_I_CONFIRM_NEW_DISPOSABLE_RESTORE_STAGING_ONLY
   ```

4. Record the returned `id` and `backend`, then verify the staged result:

   ```bash
   node tools/f10b3-admin-restore.mjs \
     --action verify \
     --restore-root /private/staging \
     --staging-id <returned-stage-uuid>
   ```

5. On LanceDB/Vectra, the files are in the NEW staging directory under `database/`. Do **not** replace an existing database with them. Reopening through the native SDK and comparing complete record inventory, vectors and metadata is a later acceptance requirement.
6. On Qdrant, the staged file is `snapshot.bin`. It is **not** uploaded to Qdrant and no new collection is created. The official, version-compatible restore procedure must first be implemented and tested with a fresh disposable collection identity.
7. For negative controls, corrupt a *copy* of staged content and confirm verification rejects it; attempt an overlapping staging root and confirm refusal. Retain redacted output and the operation UUIDs.

**Hard failures:** A live database changed, existing staged data overwritten, authentication credentials emitted, symlinks followed, corrupt bytes accepted, or any production authorization claimed. Partial directories from an interrupted stage must be investigated, not automatically deleted or activated.
