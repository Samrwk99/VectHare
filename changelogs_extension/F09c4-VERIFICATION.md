# F09c.4 — Verification

## Completed offline checks

- F09c.4 focused evidence/regression tests: **11/11 passed**.
- Entire Similharity plugin test suite: **429/429 passed** in one controlled run (`node --experimental-vm-modules --test --test-concurrency=2 tests/*.test.mjs`).
- VectHare extension: **77/77 Node test files** and **1,169/1,169 assertions** passed across ten controlled partitions; one partition was rerun after a transient failure. The initial combined extension run reported 1,162 passes and an existing `i17-emotion-cache` test-worker `SIGSEGV`; that file passed independently (7/7). A later partition run also failed transiently before passing on a rerun. This is *not* a clean single-run report.
- `node --check`: **363/363** JavaScript/ESM files across both source roots passed.
- S10 plugin executable-source fingerprint regenerated and local source manifest verified by plugin tests.
- S11 extension plugin-version and fingerprint constants were updated to the generated S10 values.
- Matched package ZIP integrity and SHA-256 are recorded in F09c4-PACKAGE-MANIFEST.json.

## Evidence boundaries

All actual Qdrant operations in these tests are simulated by in-memory transports. No live Qdrant conditional update, no external writer from a separate process, no cluster version acceptance, no real ACL isolation, no crash/restart host test, and no authoritative atomic success receipt was measured. The simulated test uses `completed` and an observed matching value to demonstrate that both can occur even when the guarded conditional update was skipped. Tests must not be misrepresented as actual backend certification.

## Production decision

**NO GO.** `qdrantV2Adapter` still does not expose a production `atomicCompareAndMutate` method, and the default S04 atomic-only gate continues to refuse uncertified operations. All production mutation capability-matrix entries remain denied.
