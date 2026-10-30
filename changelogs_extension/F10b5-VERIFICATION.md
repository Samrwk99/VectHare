# F10b.5 — Verification results

- Baseline: F10b.4 matched extension/plugin packages.
- Updated matched source versions: VectHare `2.2.0-alpha.s11.41-f10b5`, Similharity `3.2.10-s10.40-f10b5`.
- Source manifest: 66 executable/config files, local fingerprint `1b34f2d17f9ed806f7b5dd5657cb8308f928211e8d024050974e3c5d1f850e60` (local identity, **not** deployment attestation).
- Plugin complete regression suite: **574/574 passed** (`node --experimental-vm-modules --test --test-concurrency=2 tests/*.test.mjs`).
- New assessor tests: **16/16 passed**. Includes missing evidence, all-four mock complete evidence, tampering, incomplete files, source vs restored inventory mismatch, stale builds, unsafe permission claims, replay flag, symlink and hardlink refusal, symlink ancestors, and fake approvals. **These tests use synthetic local artifacts, not real backend recovery.**
- Extension suite: **1,169/1,169 assertions passed** on a complete controlled `--test-concurrency=1` run; preceding combined `--test-concurrency=2` run had an intermittent `SIGSEGV` in existing `i05-metadata.node.test.mjs` worker. No assertion failures in the successful controlled run.
- JavaScript syntax checks: passed over packaged plugin/extension `.js`/`.mjs` sources.
- CLI negative evidence run: four `BLOCKED_MISSING_HOST_EVIDENCE`; `NO_GO_PRODUCTION`; exit code `2` as expected for incomplete evidence.
- Installed native SDKs locally: LanceDB unavailable; Milvus SDK unavailable; plugin Vectra unavailable. No actual Qdrant, LanceDB, Vectra or Milvus restoration attempted.
- Real host accepted: **0/4**. Native restores: **0**. Lock releases: **0**. Reconciled uncertain writes: **0**.
- No new production mutations, native Standard support, unscoped purge, automatic replay, live unlock or restore endpoint.
