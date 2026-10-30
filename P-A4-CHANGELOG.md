# VectHare / Similharity P-A.4 — Corrective Release

Date: 30 October 2026. Matched extension `2.2.0-alpha.p-a.4` and plugin `3.2.11-p-a.4`.

## Reproduced P-A.3 defects corrected

1. **P01 server-authoritative embedding readiness.** M1's owned-collection prepare, provision, read/preview, record plan, and record execute operations now reject an ordinary configured but unverified embedding profile with `M1_EMBEDDING_PROFILE_UNVERIFIED` before database/provisioning work. A previously published M3 selected profile is accepted under its separately verified cutover/selection proof. During mutation execution readiness is reassessed after the preflight and again before the operation is dispatched (including the mutation authorization recheck).
2. **P02 mismatch guard.** If an embedding provider returns a `model` in the response object or first returned `data` entry, any identifier differing from the requested pinned model is rejected with `F09B5_PROVIDER_MODEL_MISMATCH`, regardless of correct vector dimensions. Servers that do not return model metadata remain compatible: this is *dimension verification plus a pinned request/profile*, not proof that the remote service actually ran that model.
3. **P04 retrieval freshness.** The managed text-query route checks that an ordinary embedding profile is *still* `VERIFIED` both after query embedding and after source-bound vector search. A stale verification never releases candidates.
4. **P06 restart proofs.** A regression reopens an HMAC cursor in a different Node process. A separate 170-record interrupted-batch test verifies that a second invocation recognizes 74 verified records, leaves one `WRITE_PENDING` uncertain record for review, performs only the remaining 95 writes, and never replays any prior attempt.
5. **P05 unchanged safe routing confirmed.** Both managed Repair buttons/entry points continue to use M1 plan/execute and never hash deletion; missing records are inserts, edited records updates, removed/swiped/uncertain states require review.
6. **Regression fixtures corrected.** Older M1/M3/M4 tests previously omitted the profile verification state even when simulating a ready server. They now explicitly provide `connectionState:'VERIFIED'`; no production check was weakened. An existing child-process writer-lock test was repaired so its child cannot exit before the lock is witnessed.

## Tests

* Plugin: 99 test files, **867 passing**, zero failures, across 9 bounded test batches.
* Extension: 88 Node test files, **1,245 passing**, zero failures, across 8 bounded test batches, with Node 22 `--no-opt` due crashes of unrelated VM tests without it. The other `*.test.js` Vitest suite is not included (Vitest is not installed in this environment).
* New direct negative tests cover zero DB access when profile unverified; refusal of preverified ticket after state changes; provider model mismatch (root / item / Ollama); read/profile freshness; cross-process cursor; restart with uncertain receipt and no replay.
* S10 local source manifest regenerated and checked. No source manifest entry is a claim of deployment attestation.

## Explicitly outstanding

* The installed SillyTavern/UI, real four-backend connections, local provider instance behavior, user prompt injection and provider model behavior **have not been live tested**. Mark P01–P06 as code ready / awaiting user live tests, not production-certified.
* P04 World Info activation, link traversal, conditional evaluation and semantic world-info integrations remain scoped to later P-series and M6; conditions still fail closed.
* P19's storage-write test is intentionally `SKIPPED / UNVERIFIED`, because no safe disposable server-managed fixture with independently verified cleanup exists. Its embedding diagnostic remains write-free. Never mark a skipped storage test as a pass.
* P06 has proven cross-process cursor and mock-registry restart behavior, **not** a crash-tested real S04/real vector DB resume or a new persisted batch coordinator. An uncertain operation needs manual receipt review; automatic recovery remains later P/M work.
* Capability matrix remains **32 enabled / 33 blocked / 5 unsupported**. No legacy forbidden write enabled, no cleanup/purge path unlocked. The obsolete purge button was not touched.
