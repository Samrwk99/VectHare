# F10b.6 — Disposable Qdrant host-acceptance runbook

**Operator only.** Do not use valuable collections. This tool performs an actual collection restore when connected to a Qdrant host; it is not a read-only probe. It can create a new collection. Never point it at production until separately authorized.

## Prerequisites

1. Use a **single-node**, disposable Qdrant instance reachable at `http://127.0.0.1:6333/`. Ensure no unrelated writer changes the source during backup and restore. Multinode recovery needs a separate per-node snapshot procedure.
2. Have a F09c.6 disposable source named `vh_f09c6_disposable_<32 lowercase hex>` with several recognizable vectors, IDs and payloads. Use F10b.2 to capture its Qdrant snapshot while source is quiescent and F10b.3 to stage that capture. **Keep the source unchanged until after restoration.**
3. Create distinct pre-existing private directories (mode `0700`) for backups, inert staging, F10b.6 evidence and cooperating-writer locks. The lock root **must be the same trusted root** used by participating VectHare writers for the source collection if claiming cross-process coordination. The operator is responsible for assuring this binding; a separate lock directory does not coordinate existing runtime writers.
4. The F10b.2 snapshot does not contain a snapshot-time semantic inventory. For strong acceptance, also preserve a source inventory at capture time under controlled quiescence and confirm it has not changed before the restore.
5. Never reuse an existing restore target; the tool generates a random `vh_f10b6_disposable_<32 hex>` name. It will not attempt deletion or cleanup.

## Command

From the plugin root, after obtaining actual F10b.2 **capture UUID** and F10b.3 **staging UUID**:

```bash
export F10B6_QDRANT_API_KEY='your disposable-host credential'   # omit for no-auth local fixture
node tools/f10b6-admin-qdrant-restore.mjs \
  --backup-root /private/f10-backups \
  --restore-root /private/f10-staging \
  --evidence-root /private/f10-evidence \
  --lock-root /private/participating-writer-locks \
  --capture-id <capture-uuid> \
  --staging-id <staging-uuid> \
  --endpoint http://127.0.0.1:6333/ \
  --quiescent yes \
  --single-node yes \
  --confirm F10B6_I_CONFIRM_DISPOSABLE_QDRANT_RESTORE_CAN_CREATE_A_COLLECTION
```

Do not put credentials in command-line arguments, screenshots or logs. Verify that the local REST endpoint points to the disposable server.

## Pass criteria

- A previously absent **new** target exists, the original source remains intact, and the entire bounded point inventory (IDs, vectors, payloads) matches both source-before and source-after.
- Receipt state `VERIFIED`, SHA-256 inventory digest and point count recorded. Manual native Qdrant inspection confirms matching schema/vector configuration, collection status, data persistence after service restart and absence of unexplained extra points.
- Exercise negative paths on disposable fixtures: existing-destination refusal, changed-source refusal, malformed/missing pages, upload timeout and interrupted process. Verify no automatic replay or cleanup.
- Confirm shared cooperating-writer lock behavior with the actual VectHare runtime and documented root mapping.

## Fail/review criteria

Any timeout, interruption after dispatch, inventory mismatch, missing restore collection or corrupt evidence is **UNCERTAIN**, not success. Preserve private evidence and lock; inspect host logs and physical collection manually. **Do not rerun, clear locks, overwrite or delete** the ambiguous target based on a readback alone. Contact/review under the F10b.4 investigation runbook. This tool does not implement safe administrative resolution.

## Unsupported

Production restores; existing-collection overwrites; arbitrary collection names; remote Qdrant endpoints; multi-node and Qdrant Cloud snapshot recovery; unbounded inventories; signed snapshot-time inventory attestation; full SillyTavern backup; Milvus/LanceDB/Vectra restore; automatic lock clearance.
