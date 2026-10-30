# M3g verification

## Tests

- Similharity full VM-enabled serial suite: **725 passed, 0 failed**, using `node --experimental-vm-modules --test --test-concurrency=1 tests/*.test.mjs`.
- Plugin M3-focused restore, delete, rollback and new audit tests: **21 passed**.
- Extension M3 UI tests: **3 passed**.
- Extension combined VM-enabled Node tests: **1171 passed, 1 test-file crash** in unchanged `c12-integration.node.test.mjs` (SIGSEGV, no asserted failure reported in that subprocess). The C12 test run in isolation: **7 passed**. Thus all 1178 assertions passed across the combined and separate runs, but there was no clean single combined execution.
- A first plugin attempt omitted `--experimental-vm-modules` and its VM tests failed due to the command-line invocation; the corrected command passed.
- An earlier VM-enabled plugin run had an intermittent S03 SIGSEGV; isolated reruns passed. The final full serial suite passed.

## Host acceptance

Not executed. No real SillyTavern + Qdrant acceptance evidence is available in this environment. No production capability or destructive endpoint was enabled.

## Security checks

- No browser owner ID, physical name, URL, vector, or collection target added.
- Server-internal checkpoint creation requires the nonserializable lifecycle holder and a previously durable M3 claim.
- Evidence GET checks authenticated host context and owner-specific operation document.
- Audit checksum corruption, foreign owner, missing events, and out-of-order stages fail closed.
- Recovery evidence explicitly returns `automaticReplayAuthorized:false` and `physicalLockReleaseAuthorized:false`.
