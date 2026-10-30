# F10b.7 — Disposable LanceDB / plugin Vectra native restore host runbook

**Administrator only. May read the disposable source using a native SDK and write the fresh restore clone. Never run on valuable data.** Not a full SillyTavern restore.

## Requirements

1. Install native `@lancedb/lancedb` and/or `vectra` SDK supported by the intended host. Confirm its ABI and filesystem permissions. An absent SDK causes refusal without creating a destination.
2. Use an F09c.7 disposable LanceDB source (`vh_f09c7_disposable_<32 hex>`, one `vh_f09c7_probe` table), or F09c.8 plugin Vectra (`vh_f09c8_disposable_<32 hex>`). Populate at least one vector and representative metadata value. Never use existing user indexes or native Standard.
3. Ensure the source and **all cooperating VectHare writers** are quiescent for the entire F10b.2 capture/F10b.3 staging/F10b.7 restore cycle. No concurrent compaction, migration or other SDK writer may mutate the source.
4. Obtain a verified F10b.2 local backup capture UUID and F10b.3 staging UUID. Create distinct absolute private directories (`0700`) for backup, staging, native-copy target root and evidence root. The disposable parent must be the same parent used to provision the original F09c diagnostic and its participating `writer-locks` directory.
5. Back up your real environment separately. The generated destination is new and remains on disk even after success; no cleanup is automatic.

## Run

From the installed Similharity plugin directory:

```bash
node tools/f10b7-admin-native-local-restore.mjs \
  --backend lancedb \
  --backup-root /private/f10-backups \
  --restore-root /private/f10-staging \
  --native-root /private/f10-native-reopened \
  --evidence-root /private/f10-evidence \
  --disposable-parent /private/f09c7-sources \
  --capture-id <f10b2-capture-uuid> \
  --staging-id <f10b3-staging-uuid> \
  --quiescent yes \
  --confirm F10B7_I_CONFIRM_DISPOSABLE_NATIVE_LOCAL_RESTORE
```

For Vectra, use `--backend vectra` and the F09c.8 disposable index parent and corresponding capture/stage UUIDs.

## Verify and report

- Native SDK opens original synthetic source and the *newly reconstructed clone*. Source pre-reopen, restored clone, and source post-reopen produce identical **full bounded record inventories** (including vector arrays and metadata fields), not merely matching counts. No extra LanceDB tables or empty fixture.
- Verify staged backup and original source files remain intact. Check evidence receipt `VERIFIED`; inspect cloned index manually after a full SillyTavern/Node restart. Confirm query and persistence through the same native SDK.
- Exercise source-change and corrupt-stage negative controls on new fixtures; test lock failure/retention after simulated interruption. Keep redacted logs and SDK/OS version details.
- If any native operation throws, files drift, or inventory differs, the case is **UNCERTAIN**; do not retry, remove retained lock, delete clone, or claim recovery. Use F10b.4 administrator investigation and keep evidence.

## Not certified

No actual LanceDB or Vectra native SDK run occurred in the packaged offline environment. This runbook does not enable writes to actual user collections, production restores, deletion/purge, legacy/native Standard, automatic lock removal, Milvus backup, or full SillyTavern disaster recovery.
