# F10b.4 — Disposable-host recovery investigation runbook

**Scope:** private CLI for forensic review. Use the matched VectHare/Similharity build on a disposable SillyTavern profile. Do not run against valuable data as an experiment. Take an external copy of the whole profile before testing; retain locks for unresolved writes.

1. Establish the trusted per-user `vectorsPath`, `userScopeId`, canonical collection key, exact backend (`qdrant`, `lancedb`, `vectra`, `milvus`) and physical collection name from server-side S02/F03 mappings. Do not derive these from untrusted browser input.
2. On the disposable host, create an interrupted F09c mutation with an `UNCERTAIN` or `SUBMITTED` S04 receipt and a retained F09c.10 cooperative lock. Do not fabricate such a state on valuable data.
3. Run from the plugin installation:

```bash
node tools/f10b4-admin-investigate.mjs \
  --action inspect \
  --vectors-path /private/disposable/vectors \
  --user-scope-id '<trusted-owner>' \
  --backend qdrant \
  --collection-name '<trusted-physical-name>' \
  --collection-key '<64-character-key>'
```

4. Expect `UNRESOLVED_MUTATION_BLOCKED`, with lock and pending-intent counts. Do not retry operations. To preserve a private, reviewable case:

```bash
node tools/f10b4-admin-investigate.mjs \
  --action stage \
  --vectors-path /private/disposable/vectors \
  --user-scope-id '<trusted-owner>' \
  --backend qdrant \
  --collection-name '<trusted-physical-name>' \
  --collection-key '<64-character-key>' \
  --confirm REVIEW_ONLY_NO_UNLOCK_NO_REPLAY
```

5. Verify the returned case ID with `--action verify --case-id '<uuid>'` and the same trusted binding arguments (omit `--confirm`). Keep the case and redacted stdout; the case is locally hash-checked, not signed attestation.
6. Verify terminal receipts with retained locks still report `RETAINED_LOCK_REQUIRES_HOST_REVIEW`. A missing lock does **not** authorize a new write if an S04 or managed intent remains pending.
7. On a **copy of the disposable profile**, corrupt the receipt checksum, add a symlink into the operation directory, or change the collection binding. Confirm the tool refuses; do not alter your normal installation.
8. Independently verify process quiescence, actual native backend record/revision state, interrupted-write outcome and backup coverage. **Those are manual acceptance prerequisites for future resolution code; F10b.4 does not act on them.**

**Hard failure:** any receipt promotion, lock unlink, mutation replay, cross-user inspection, leaked stored content/credentials, or automatic production permission from these commands. Preserve logs and do not continue mutating that collection.
