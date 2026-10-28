# E06 — Local verification results

28 October 2026. Against the **E05 cumulative extension**; Similharity unchanged.

## Passing evidence

- **53 Node test files, 1,058 of 1,058 cases passed** when executed in individual Node processes using `node --experimental-vm-modules --test`. See `E06-PARTITIONED-TEST-RESULTS.json` for per-file status and counts.
- **54 E06 contract/probe cases** passed (shared tenant parsing, foreign IDs, ownership, rejected inventories, mutation zero-fetch, safe read probe and real adapter VM behavior).
- E01, E02, E03, E04, E05 and E06 offline static audit scripts all returned success.
- 210 JavaScript/MJS source files passed `node --check`.
- Original  E05 files not listed as changed in the release manifest are byte-identical to the E05 ZIP.

## Combined-run limitation — do not misrepresent

A combined `node --experimental-vm-modules --test --test-concurrency=1 tests/*.node.test.mjs` invocation intermittently exited with a **SIGSEGV** in older VM-based tests (`c12-integration` and, separately, `c09-hybrid`). The same files passed in isolation. The final partitioned run passed every test case. **We do not claim a single clean combined run.** The collected combined output shows this process-level failure, not an E06 assertion failure.

## Not performed

- No running SillyTavern instance, Qdrant instance, Milvus instance or live backend request tested.
- No installed plugin hash attestation, two-run-after-restart validation, tenant cross-user acceptance or actual prompt-inclusion verification.
- No destructive probes and no mutation gating changes.
- No plugin code modifications, no Qdrant/Milvus write activation, no Standard/LanceDB write activation.

## Operational limitation

The Milvus read path will now reject responses lacking verifiable `type`/`sourceId` ownership in returned metadata, and Qdrant/Milvus saved-hash enumeration will explicitly refuse rather than assert a complete inventory. These are intentional availability restrictions to prevent ambiguous reads and incorrect deletion decisions. They do not repair the underlying plugin.
