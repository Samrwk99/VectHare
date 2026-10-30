# F09b.8 — Verification

## Results

- Plugin: `node --experimental-vm-modules --test --test-concurrency=1 tests/*.test.mjs` — **400/400 passed**, including **10 new F09b.8 integration tests**.
- Extension: **77/77 test files** and **1,169/1,169 assertions** passed (1,165 in controlled partitions plus 4 from a separately rerun worker). Three new F09b.8 tests passed in the partitions.
- Caveat: one combined partition run encountered `SIGSEGV` for the pre-existing `c09-hybrid.node.test.mjs` worker, rather than a failed assertion. Its four assertions all passed when the file was rerun independently. Therefore **do not claim the initial ten partition runs were wholly green**.
- Plugin `S10-BUILD-MANIFEST.json` generated from packaged runtime source and verified by `loadS10Build()` as `MATCHED_LOCAL_SOURCE_MANIFEST`.
- Extension S11 pin matches plugin version, contract version 2, and executable source fingerprint.
- Matched source archive hashes and ZIP integrity checked during packaging; handover manifest includes hashes.

## What the integrated assertions actually exercised

The per-backend tests select Qdrant, LanceDB, plugin Vectra, and Milvus but use **a shared in-memory adapter / simulated backend pool**, not live services. They create and read authenticated **disposable host-file fixtures** and persist real per-user managed registry/ledger artifacts under temporary directories. They exercise the actual F09b.3, F09b.4, F09b.5, F09b.6 and F09b.7 workflow functions against those dependencies. They verify source identity, scoped collections, one-record mutation boundaries, tombstone anti-resurrection, stale saved-content refusal, and read-only link diagnostics.

## Not proved / release blockers

No live SillyTavern/Termux/Windows, real provider, Qdrant, LanceDB, Vectra, Milvus or native Standard acceptance. No multi-process external-writer CAS, crash-uncertain automatic reconciliation, full backup/restore, legacy vector handling, complete backend inventory, automatic chat/World Info sync, generated summaries, condition activation, link traversal, purge, or production permissions. **Release remains `DEVELOPMENT_ONLY_NO_GO`.**
