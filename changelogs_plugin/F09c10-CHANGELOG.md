# F09c.10 — Runtime-wide cooperative lock integration

Baseline: F09c.9 matched VectHare/Similharity packages.

- Added `lib/f09c10-runtime-boundary.js`: centrally derives a private physical-collection writer lock from the authenticated S04 ledger user context and immutable mutation plan. It refuses symlinked/world-accessible roots and mismatched user scope. No client-controlled lock path.
- Updated `lib/s04-engine.js` so **every** S04 mutation invocation uses the F09c.5 collection writer gate by default, covering Qdrant, LanceDB, plugin Vectra, Milvus, F09b chat sync/lifecycle, saved summaries and World Info, and existing S04 pilot/acceptance routes. An explicit gate remains possible for administrator-only disposable diagnostics.
- A confirmed pre-dispatch failure returns an internal `FAILED` result to the writer gate and then rethrows its original error; this safely releases the lock. A `SUBMITTED`, `UNCERTAIN`, interrupted or otherwise ambiguous dispatch retains the lock and never automatically retries.
- Updated `lib/f03-provision.js` so new collection schema provisioning uses that **same trusted collection-level writer lock**, in addition to its durable F03 receipt and S04 per-user ledger lock. Uncertain schema creation retains the lock.
- Added `tests/f09c10-runtime-lock.test.mjs` with all four backend mock paths, competing engines, source isolation, pre-dispatch refusal, symlink refusal, deterministic collection scope, static normal-route inventory and a real second Node process force-killed during simulated dispatch.
- Updated two earlier expected error assertions: retries following uncertain operations are rejected by the retained F09c.5 lock (`F09C5_WRITER_BUSY`) before reaching the old replay/receipt checks.
- Updated matched extension/plugin release pin and source manifest. No new public HTTP write route or production permission.

**Accepted writer model:** Only writers that cooperate with the same VectHare lock are protected. Independent direct database writers are deliberately outside the guarantee. A separate deployment or different lock root has no coordination guarantee. Legacy and native Standard writes remain denied under the v2 gateway.
