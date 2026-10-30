# E05 — Standard and LanceDB verified-write preparation

Date: 2026-10-28. Baseline: E04 cumulative build. **Plugin unchanged.**

## Runtime changes

1. `backends/lancedb.js`: replace single-page `getSavedHashes` with bounded, **twice-read** paginated inventory. Each page must have an explicit total, offset, positive limit, stable count and coherent `hasMore`; duplicate hashes, changes between passes, errors and over-limit inventories fail closed. Numeric hash return type preserved.
2. `backends/lancedb.js`: preflight every candidate insert for complete finite precomputed vectors, uniform vector dimension, unique physical hashes and a **lossless LanceDB table name**, before calling the E02 transport. This protects against the plugin's silent invalid-vector skipping and sanitized-table collisions for *new* writes; it does not retroactively validate existing tables.
3. `backends/standard.js`: preflight candidate inserts for unique hash, explicit finite precomputed vectors and uniform dimension. This applies even before its plugin/native fallback decision. Native and plugin transports remain separate and denied for unprobed mutations by E02.

## Added code

- `utils/e05-verified-write-contract.js`: backend identity and batch validators; evidence-only, double-sweep inventory; collision checking; readback verification of hash, text, vector and caller-specified metadata; conservative insert protocol with pre-operation journal persistence and independent journal readback; no automatic retry after uncertain mutation.
- `tools/e05-disposable-probe.mjs`: **manual local-only** source-contract probe for Standard/Vectra and LanceDB. Requires explicit `VECTHARE_PROBE_DISPOSABLE=1`, localhost/loopback origin, no URL credentials, and a unique new test collection. Checks health, empty inventory, insert, verified list, point readback, delete and empty inventory; does not purge. An interrupted test may leave one unique probe record and must be reconciled manually. One passing run is **not** certification; repeat after a real server restart and verify deployed plugin identity.
- `tests/e05-write-contract.node.test.mjs`: 38 offline contract/safety tests.
- `tools/e05-verify.mjs`: static E01–E04 non-regression and E05 guard checks.

## Test fixture corrections

Legacy I04/I05/I08 VM test environments now supply E05 helpers and explicit vectors. I04's LanceDB list fixtures now use the real plugin pagination envelope and account for two independent sweeps. Tests remain meaningful; no production guard was weakened to satisfy fixtures.

## Deliberate non-changes

- E02 capability statuses **unchanged** (`insert`/`delete` still UNPROBED for Standard and LanceDB; denied for Qdrant and Milvus).
- `BACKEND_CAPABILITIES` remain UNKNOWN; no fake server proof.
- No `/chunks/purge`, `/purge-all`, `PATCH /text`, credential forwarding, backend deletion capability unlock, or plugin modification.
- The E05 verified-write primitive is **not wired into normal user mutation flows** until the required live contract and persistence acceptance. The E02 gateway continues to reject those calls.

## Known limitations / acceptance blockers

- No live SillyTavern, plugin, Vectra, LanceDB, browser or server restart was present during this checkpoint. The supplied source is **not** a runtime source attestation.
- Source review indicates LanceDB `insertVectors` appends and does not prevent duplicate hashes, while `/chunks/delete` reports echoed counts; neither response proves commit. Point lookup can return the first duplicated hash only. E05 must prohibit writing colliding hashes.
- The plugin's process-global LanceDB `basePath` may alias different SillyTavern users; multi-user isolation must be tested before activation.
- Standard's native `/api/vector/*` endpoints are **not** defined by the supplied Similharity source. They need their own host-version contract probes; a Standard plugin-pass does not certify native fallback.
- Double-sweep list is more expensive; a limit of 10,000 records / 100 pages per pass prevents a silent truncated result, but it can block large collections.
- The speculative verified-write primitive accepts callback transports and a journal, but it is not certified as an end-to-end runtime flow. A real host C02 journal and Web Locks integration are prerequisites before production use.
