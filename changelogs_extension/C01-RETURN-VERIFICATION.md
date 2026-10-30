# C01 return — verification report

Date: 2026-10-27

| Suite | Passed | Failed |
|---|---:|---:|
| I01–I18 regressions (`npm run test:repair`) | 199 | 0 |
| Phase 0 (`npm run test:p0`) | 33 | 0 |
| C01 (`npm run test:c01`) | 50 | 0 |
| C04/C06/C11 Stage A (`npm run test:dependencies`) | 24 | 0 |
| C04/C06/C11 Stage B (`npm run test:dependency-b`) | 31 | 0 |
| Pinned-source contract ledger (`node --test tests/c01-plugin-contract.node.test.mjs`) | 2 | 0 |
| **Total** | **339** | **0** |

- `node --check` passed for 128 `.js`/`.mjs` files in the project.
- Read-only plugin source auditor found all expected file SHA-256 fingerprints and reported `safeForLiveDeletion:false`.
- The plugin was **not edited, packaged with the extension, started, or called over HTTP**.
- No SillyTavern instance, backend database, live persistence path, or real vector collection was used.
- Positive deletion tests use deterministic fake backends and simulated durable acknowledgements. They are **not** evidence that live purge and durable settings save work.
- Real plugin and SillyTavern versions are unverified despite having a local plugin source archive.
- Further unresolved work is itemised in `C01-RETURN-CHECKLIST.md`.

This is a **safety checkpoint**, not production certification or completed live C01 acceptance.
