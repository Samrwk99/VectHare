# C08 verification — local checkpoint

**Input baseline:** `VectHare-Step7-C05-Cumulative-Security-Checkpoint.zip`.

| Suite | Expected test count | Result |
|---|---:|---|
| I01–I18 original regressions | 199 | PASS |
| Phase 0, C01, C03, C04/C06/C11, C07, C02, Step 6, C05 | 361 | PASS |
| C08 activation, World Info identity, and frequency tests | 44 | PASS |
| **Cumulative** | **604** | **604 passed** |

These are local JavaScript and simulated-host tests, **not** live SillyTavern/plugin compatibility tests. Checksums, syntax, unchanged-baseline comparison and ZIP integrity are recorded in the release manifest.

### Important distinctions

- The tests establish that a **simulated verified final inclusion receipt** is counted once per user turn; live VectHare still lacks a C10 verified receipt and therefore withholds frequency-conditioned chunks.
- Tests of `WORLD_INFO_ACTIVATED` consume synthetic event payloads, not a captured event from the user's deployed SillyTavern version. Event order relative to the generate interceptor is unverified.
- A skipped candidate, dry run, registered-only prompt, and unknown outcome **do not** spend frequency history.
- This checkpoint does not modify the separately provided Similharity plugin; C01/C02 deletion and C05 protected-secret capability restrictions are retained.

### Package integrity

- Baseline files unchanged: **221**; intentionally modified: **7**; removed: **0**; added source/tests/docs: **6** (before release manifest).
- Syntax validation: **148 JavaScript / ES module files** passed `node --check`.
- Cumulative test rerun: **604/604 passed**, using a serial Node test runner.
- ZIP integrity and SHA-256: supplied alongside release.
