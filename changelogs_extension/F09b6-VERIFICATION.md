# F09b.6 — Offline verification

- **Plugin:** 379/379 passing assertions; `node --experimental-vm-modules --test --test-concurrency=1 tests/*.test.mjs`. Eleven new F09b.6 tests cover stable lorebook UID identities, saved-summary metadata, exact owned insert/update, stale preview, races, uncertain operation replay prevention, backend-scoped writes across four adapters (with offline fixtures), source ownership and symlink rejection, historic/untracked record refusal and redacted routes.
- **Extension:** 1,164/1,164 assertions across 75 `.node.test.mjs` files; executed in ten controlled groups (8 files per group, last group 3 files), each with zero failures. Two isolated Node worker `SIGSEGV` crashes happened on earlier monolithic extension runs; both implicated files passed independently, and every test later passed in controlled partitions. **Do not claim the single monolithic extension invocation was clean.** Two new F09b.6 client/gateway assertions included.
- **Syntax:** all enumerated `.js` / `.mjs` sources in both working packages passed `node --check` (non-mutating static parsing).
- **Plugin source:** S10 local manifest recalculated and `loadS10Build()` returned `MATCHED_LOCAL_SOURCE_MANIFEST`; SHA-256 source fingerprint `9908dffe698993291b1d62f4b9f05a6445c129ebbda2d33aa792f1fc298938c7`. The extension S11 expected plugin fingerprint was pinned to this exact matched source.
- **Compatibility contracts:** F09b.6 route/capability is declared by S10 and checked by S11; pre-existing source safety and extension compatibility tests passed.

## Not verified

Actual SillyTavern summary metadata formats, host-authenticated directory layouts on a real installation, real remote embedding providers, Termux, real Qdrant/LanceDB/Vectra/Milvus writes or concurrency, cross-process races, external-writer CAS, full recovery/backup, normal World Info activation or LLM-produced summary pipeline, and any production permissions.

**Decision:** restricted saved-source preview/one-record pilot implemented and offline-tested; **PRODUCTION NO GO**. Full summary and World Info feature parity **not achieved**.
