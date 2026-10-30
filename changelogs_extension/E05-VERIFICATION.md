# E05 — Verification report

**Date:** 28 October 2026. **Baseline:** VectHare E04 cumulative ZIP. **Scope:** extension-only, Standard/Vectra and LanceDB verified-write preparation. **Similharity:** untouched.

## Measured local results

- Full Node test command: `node --experimental-vm-modules --test --test-concurrency=1 tests/*.node.test.mjs`.
- Latest full clean run: **1,003 tests, 1,003 passed, zero failures**, 52 Node test files. Log: `E05-FULL-TEST-OUTPUT.txt`.
- E05 new contract tests: **38**, including test-only simulated probe transports and vector readback mismatch.
- `node --check` on **206** `.js` and `.mjs` files: **206 passed**, zero failures.
- E02 static audit: pass (98 E01 request edges, 12 gateway aliases).
- E03 static audit: pass (11 persistence/lock/recovery checks).
- E04 static audit: pass (11 read-only/prompt/export checks).
- E05 static audit: pass (16 write-preflight/probe/restriction checks).
- A preliminary full run reported 14 failures caused by pre-E05 isolated VM loaders and legacy fixtures; the fixtures were updated to provide the E05 contract dependencies and to reflect real LanceDB paginated responses. A later full run had an intermittent `SIGSEGV` in the historical C09 hybrid VM test file (matching earlier E03 runner instability); that file passed independently (4/4). The final full run passed cleanly.

## Source-derived findings (NOT live proof)

- Plugin `index.js` allows Standard/Vectra and LanceDB `/chunks/insert`, `/chunks/list`, `GET /chunks/:hash`, `/chunks/delete` but the `{inserted,deleted}` counts merely echo supplied array sizes.
- LanceDB backend `insertVectors` appends via `collection.add(records)` and can skip invalid vectors; it does not implement unique-hash upserts. E05 preflight prevents a new request containing duplicates or missing vectors, but cannot guarantee exclusivity against external writers.
- LanceDB table names are sanitized with `collectionId.replace(/[^a-zA-Z0-9_.-]/g, '_')`; lossy names can alias. E05 refuses such names for candidate writes.
- LanceDB list returns a full array and index.js slices it in memory; E05 now checks every page with a bounded two-pass sweep. This has performance costs; it is not a substitute for snapshot isolation or independent server-side count proof.
- Standard plugin Vectra uses `upsertItem`, whereas the SillyTavern native Standard API is not specified by this plugin. The two planes require separate certification.

## Not tested in this checkpoint

No live SillyTavern host, actual plugin HTTP route, LanceDB native library, Vectra disk store, real browser, external authenticated backend, restart persistence, concurrent third-party writer, or multi-user storage isolation was available. The CLI probe was run only against an in-memory fake HTTP transport during tests, not real infrastructure. No plugin runtime identity was authenticated or verified.

## Release status

**E05 implementation work: completed locally. E05 write activation: NOT COMPLETE / NOT CERTIFIED.** All E02 native/plugin mutation restrictions remain. End users will not regain vector insertion, edit, delete or replacement simply by installing this checkpoint; these operations require actual disposable-host acceptance and a subsequent carefully reviewed capability change. This checkpoint is NOT a production release.
