# C09 — Verification report

- Source baseline: `VectHare-Step8-C08-Cumulative-Activation-Checkpoint.zip`
- Baseline SHA-256: `e574534f59dc34fd94c8e5491b3c067eca33edac2ada8a747e1fee19429a89f0`
- Similharity plugin (unchanged, reference only) SHA-256: `51f74de9c7e57524cc3f1f881b03069805e654b162a8f5ccb77d012b0a2604a7`
- Original I01–I18 tests: **199/199** passing.
- Previously delivered safety and development tests: **405/405** passing.
- New C09 tests: **47/47** passing.
- **Cumulative verified: 651/651** passing across node-based suites.
- JavaScript and ESM syntax checks: **153 files** passed `node --check`.
- Test method: `node --test --test-concurrency=1` (with `--experimental-vm-modules` where VM suites require it).
- Worker instability: one concurrent C09 worker run crashed with SIGSEGV; serial rerun passed. The final verification also passed all suites (C09 required a rerun due to the intermittent runner crash). A worker crash is not an assertion failure, but is a test-environment limitation.
- ZIP CRC/integrity: verified at package time.
- No deployment against an actual SillyTavern/Similharity instance; no production compatibility claim.
- Backend contract flags remain unknown for unverified scoped read, paginated inventory, and lexical endpoints.
- Similharity plugin not modified or bundled.
- Final test machine-readable results: `C09-TEST-RESULTS.json`.

## Test totals by suite

| Suite | Passed |
|---|---:|
| I01-I18 | 199/199 |
| Phase 0 | 33/33 |
| C01 | 50/50 |
| C04/C06/C11-A | 24/24 |
| C04/C06/C11-B | 31/31 |
| C03 | 38/38 |
| C07 | 40/40 |
| C02 operations | 50/50 |
| C02 integration | 11/11 |
| Step 6 foundation | 35/35 |
| Step 6 cache | 2/2 |
| C05 | 47/47 |
| C08 | 44/44 |
| C09 | 47/47 |

## C10 handoff

Prompt-token trimming must operate on the final C09 selections, then provide a real host-assembled inclusion receipt before C08 activation counts are spent. Backend lexical and linked-member reads must not be enabled on mock success alone.
