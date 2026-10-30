# VectHare C14 — Verification Report

**Inputs:** Step 13 cumulative extension ZIP; supplied Similharity plugin archive inspected read-only. No deployed SillyTavern/Similharity runtime was available in this run.

## Automated Node regression tests

- **855 / 855 tests passed**, executed in individually isolated Node processes. Baseline through C13: 823; new C14 tests: 32.
- Suites: I01–I18 199; Phase 0 33; C01 50; C04/C06/C11 A+B 55; C03 38; C07 40; C02 61; Step 6 37; C05 47; C08 44; C09 47; C10 58; C11 33; C12 37; C13 44; C14 32.
- Some combined Node `--test` worker runs crashed with **SIGSEGV without assertion failures** in previously known VM-dependent tests (C09 hybrid, C12 integration). Isolated reruns passed (C09 hybrid 4/4; C09 remaining 43/43; C12 integration 7/7; C12 remaining 30/30). A single isolated I05 worker also crashed once; an independent retry passed all 15 assertions. These are test-runner instability observations, not evidence of production compatibility.
- Source-level checks: `node --check` on all 173 JS/ESM files passed.
- 7 original files changed, 3 source/test files added, no files removed. C14 is opt-in.

## C14 cases

Path routing, model honesty, custom supported labels, prototype identity/cache, single-flight requests, late cache invalidation, confidence ties, neutral fallback, invalid vector shapes and dimensions, provider failure recovery, unsupported authenticated/alternate sources, no browser secret forwarding, error ACKs, and 14-sentence synthetic-evaluation fixture.

**Accuracy:** The 14/14 score in controlled fake embeddings tests is proof of scorer/test harness wiring only. Real embedding-model accuracy is **NOT MEASURED** and must be evaluated on the actual deployed plugin and host model before trusting automatic emotion assignments.

## Live acceptance still outstanding

1. Confirm deployed plugin is the inspected source and `/batch-embeddings` returns verified same-model vectors.
2. Test model switches, server updates, cache invalidation and latency with real host.
3. Measure false-positive/neutral rates and label accuracy on a suitably representative dataset; calibrate threshold and margin.
4. Verify Cotton-Tales calls into `window.VectHareEmotionClassifier` in the actual extension environment and captures the expected result structure.
5. All earlier C01–C13 backend/persistence/host gates remain in effect; plugin not modified.
