# S01 Verification — source and offline tests

**Date:** 28 October 2026  
**Scope:** Uploaded Similharity source only; no running SillyTavern or databases used.

## Source baseline

The input ZIP's SHA-256 hashes match the previously supplied E06 reference:

| Input file | SHA-256 |
|---|---|
| `index.js` | `32a2aba3a83511a61c34620c600db5a91c04b4d638c02919a4d0bf7217a5a287` |
| `qdrant-backend.js` | `3fd587cf9adbe3da8e8ee53c397ab46b943f95a13c58f325f89f327d961ab149` |
| `milvus-backend.js` | `fc3c81888a9bd30d770d99a4fce6735e819a4079fc5c36717dc88ca16715fa6b` |

## Test execution

- `npm run check:s01`: JavaScript syntax checks on five source modules; PASS.
- `npm run test:s01`: **20 tests, 20 passed, 0 failed** (Node 22.16.0, `--experimental-vm-modules`).
- Qdrant dimension mismatch/mock collection inspection: PASS; no purge/create calls. Missing collections also fail closed.
- Milvus dimension mismatch, missing field, describe exception: PASS; no drop/create calls.
- Direct backend legacy mutation refusal: PASS.
- All six legacy HTTP route types refused before network dispatch; fallback route handlers also refuse: PASS.
- Qdrant network mutation retry bounded to one attempt: PASS.
- Qdrant and Milvus simulated read failures propagate: PASS.
- LanceDB rejects malformed vector batch without opening the backend: PASS.
- Source inspection: no direct `dropCollection` operation remains in the Milvus adapter; Qdrant `purgeAll` and LanceDB `purgeAll` are refusing stubs: PASS.

## Not tested (important)

- Plugin load in a running SillyTavern host.
- Qdrant, Milvus, LanceDB and Vectra live backend behavior.
- Real authentication/CSRF, user-isolation or cross-tenant retrieval protection.
- Final outgoing model prompt, settings persistence or browser recovery.
- Complete inventory, reliable counts, safe insert/edit/delete and data migration.
- Production performance, concurrency and restart failure injection.

**Release decision:** `SAFE-FAIL-CLOSED-SOURCE-CHECKPOINT`, **not** `PRODUCTION-READY` or `WRITES-ENABLED`.

## Re-run

```sh
npm run check:s01
npm run test:s01
```

No dependency installation is required for the tests: backend SDKs and host routing are mocked. These tests do **not** replace actual backend integration tests.
