# F10b.5 — Disposable-host backup, restore, and recovery acceptance

**Status at package creation: NO GO.** This is a host acceptance *kit*, not host acceptance evidence. F10b.1–F10b.4 created restricted capture, staging and forensic review operations. **Native restoration, Milvus Backup integration, authoritative uncertain-write resolution and safe lock release are not implemented or certified.** Never infer those features from the assessor's output.

## Preflight

1. Install **both matched F10b.5 packages** in a disposable, isolated SillyTavern profile. Preserve a separate backup of your normal profile. Verify the S10 plugin source fingerprint and the extension S11 pin. Do not test against valuable vector collections.
2. Use only the F09c.6 Qdrant, F09c.7 LanceDB, F09c.8 plugin Vectra, and F09c.9 Milvus **fresh disposable** source identities. Confirm tested backend versions, relevant SDKs, host platform, and VectHare user-scope binding. No native Standard or legacy migration is implied.
3. Verify the accepted deployment boundary: cooperating VectHare processes share the same lock root; unrelated applications bypassing VectHare are outside the concurrency guarantee. Stop external writers and background compaction before cold filesystem captures; the lock alone does not freeze the native backend.
4. Record initial source inventory (including **every** record's stable non-secret ID, revision, vector SHA-256, and metadata SHA-256), using the actual backend read APIs, and independently compare record counts and dimensions. Keep raw vectors/secrets out of review artifacts.

## Actual host operations required — do not manufacture PASS evidence

1. Run the F10b.1 control-plane snapshot/rehearsal on the disposable profile, and verify S02 mapping, S04 receipts, managed registry and tombstones. Capture logs with redactions.
2. Execute F10b.2 physical backup against the disposable source. Qdrant: native collection snapshot. LanceDB/Vectra: proven quiescent local copy. **Milvus: blocked until supported Milvus Backup tooling is implemented and tested.** Capture exact source backend/version and artifact hashes.
3. Use F10b.3 to stage a *fresh* restore location and verify the staged bytes. This does **not** constitute successful database restoration.
4. On a separately protected disposable environment, use a backend-supported restore/reopen process (when implemented). Re-enumerate **all** records through the native API. Verify exact ID, revision, vector hash, metadata hash, collection identity, count and dimensions. Never overwrite or activate an existing collection.
5. Restart the host between checks, and prove persistence and mappings. Test two cooperating VectHare processes writing under one collection lock (no simultaneous dispatch). Test source/user/branch isolation.
6. Simulate interrupted operations on disposable data. Verify `SUBMITTED`, `UNCERTAIN`, F09b4 pending managed intents and retained locks remain blocked and are not replayed, silently promoted, or manually unlinked. **There is no certified safe unlock procedure in F10b.5.** A host result cannot make an unimplemented recovery action safe.
7. Rehearse a rollback on disposable data, verifying that valuable/existing collections remain untouched, state inventories remain intact, and uncertain writes are not re-dispatched.
8. Independently review process quiescence, native SDK output, fault-injection logs, permissions, backup completeness, and all captured nonsecret evidence. Do not claim an authoritative backend outcome solely from matching readback.

## Evidence assessor — read only

Create a private directory (0700) with at most four subdirectories named `qdrant`, `lancedb`, `vectra`, `milvus` (0700). Each backend directory contains `host-evidence.json` and only the referenced evidence files (0600, regular, no symlinks/hardlinks; each <= 2 MiB).

Use the provided `evidence/host-evidence.template.json` as the structure. Set `schemaVersion=1`, `checkpoint=F10b.5`, `environment=DISPOSABLE_HOST_ONLY`, correct `backend`, UUID `hostRunId`, and matching F10b.5 versions/fingerprint. Each entry of `artifacts` contains one unique `kind`, filename and **actual sha256 of the file bytes**, plus `result:PASS` based on executed tests. Required kinds:

`control_plane_capture`, `physical_native_backup`, `native_disposable_restore`, `source_inventory`, `restored_inventory`, `cooperating_writers`, `crash_uncertainty`, `restart_persistence`, `scope_isolation`, `rollback_rehearsal`, `quiescence_review`.

The inventory artifacts are JSON documents with schema `{"schemaVersion":1,"backend":"qdrant","records":[{"id":"safe-123","revision":1,"vectorSha256":"<64hex>","metadataSha256":"<64hex>"}]}` (use the appropriate backend). They must represent **all** native records and be independently produced before and after the native restoration. The assessor canonicalizes record ordering and compares the records; it cannot independently establish that the inventories were genuinely obtained from native backends.

From the plugin installation:

```sh
node tools/f10b5-admin-assess.mjs --evidence-root /absolute/private/disposable/evidence-root
```

A missing backend is `BLOCKED_MISSING_HOST_EVIDENCE`; incomplete artifacts are `BLOCKED_INCOMPLETE`; changed hashes or bad manifests are refused; unequal native inventories are `BLOCKED_INVENTORY_MISMATCH`. Even with all checks present, the maximum result is `READY_FOR_INDEPENDENT_MANUAL_REVIEW` and overall `NO_GO_PRODUCTION`.

## Acceptance blockers / stop conditions

- Any altered source, broken artifact hash, scope mismatch, unexpected directory entry, symlink, stale fingerprint or missing evidence is a hard stop.
- No native restore proof, no verified complete vector/metadata inventory, unproven crash recovery, or unimplemented Milvus backup **prevents declaring full F10b complete**.
- No existing or valuable collection overwrite, automatic production promotion, unscoped purge, mutation replay, or lock unlink is authorized.
- Production decisions require independently examined real-host evidence and separate development/verification of the missing native restoration and authoritative recovery mechanisms. F09c live backend certification remains a separate outstanding gate.
