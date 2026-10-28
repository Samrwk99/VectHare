# F10 — SillyTavern host test runbook (Termux, Windows, Linux)

**Use disposable SillyTavern data and a newly provisioned disposable v2 collection.** This feature does not cover your existing legacy Qdrant vectors. Install both matching F10 components, restart SillyTavern and confirm the F10 plugin build is detected. Do not overwrite valuable installations without backing them up through an independently established method.

1. Open a saved disposable chat and ensure it passes F01 source attestation; select a backend you can reach from SillyTavern (Qdrant on Termux is a sensible first test). Provision the corresponding new v2 collection through F03. Set the exact embedding source, model, dimension and metric.
2. Insert one or more harmless test vectors using the backend's explicit F04/F06/F07/F08 *pilot* only, if permitted by its safety gates. Do not turn on ordinary writes or bypass an operation denial.
3. Under **F10 — scoped record evidence**, choose that backend/source/embedding and click **Capture scoped record evidence (NOT a full backup)**. Read the explicit warning and confirm. Record its capture UUID and count.
4. Click **Verify capture integrity** using that capture UUID. This should verify the private file's checksum and currently owned source mapping without executing a vector mutation.
5. Click **Download non-authoritative evidence JSON**. Confirm it contains only the disposable source's test records and that its filename states `NOT-A-FULL-BACKUP`. It must not claim a verified complete inventory, atomic snapshot or migration rights.
6. Edit the disposable record through the permitted pilot, then repeat the capture. Expect a new UUID rather than replacement of the original. Compare the captures manually; they represent separate observations, not transactionally consistent snapshots.
7. Switch to a different saved chat or copy a branch ID. A capture for the first source must not be downloadable from a different source selector. Missing/changed saved-file identities should be refused.
8. Restart SillyTavern and verify the original receipt again. If it fails, capture the exact error; do not attempt manual database purge or recovery.
9. Optional security tests on a disposable installation: invalid capture UUID, a stale/missing saved source, mismatched embedding configuration, oversized collections and interrupted scans should all refuse without claiming success.

**Acceptance to report:** operating system, SillyTavern version, backend type/version, extension/plugin versions, result of capture/status/download, record count, errors and whether the receipt still verifies after restart. Do not share database credentials or private memory content.

**Expected labels:** `authoritativeInventory:false`, `verifiedFullBackup:false`, `snapshotConsistency:"UNPROVEN"`, `restoreAllowed:false`, `migrationAllowed:false`, `productionWritesEnabled:false`.

**Remaining before production-grade F10:** independently verified complete consistent inventory (snapshot or enforced quiescence with external-writer controls), real-backend pagination and crash acceptance, trusted source ownership for legacy data, migration staging with independent readback, rollback proof, and approved cutover. F09's unfinished ordinary-memory workflow remains outstanding.
