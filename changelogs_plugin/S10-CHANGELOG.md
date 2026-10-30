# S10 — API and plugin finalization (source/offline checkpoint)

**Baseline:** cumulative S09 `3.2.9-s09.0` · **Release:** `3.2.10-s10.0`

## Source modifications

1. **Runtime version corrected.** `index.js` module version and info/health value now agree with `package.json` (`3.2.10-s10.0`); previous cumulative `index.js` still reported S05.
2. **Manifest-verifiable executable source.** `lib/s10-build.js` inventories all runtime `.js/.mjs` files below `lib/` and the four backend/entrypoint files plus `package.json`; computes SHA-256 hashes and a deterministic aggregate; refuses mismatches, missing/extra executable sources, symlinks and package-version inconsistencies at plugin registration.
3. **Reproducible S10 build manifest.** `tools/s10-build-manifest.mjs` generates `S10-BUILD-MANIFEST.json`. This manifest is self-reported local source integrity, **not signed deployment attestation**, and does not measure node_modules or the host runtime.
4. **Conservative capability registry.** `lib/s10-contracts.js` reports per-backend operation states and distinguishes Similharity's Vectra path from native SillyTavern Standard. All public v2 mutations and verified export/migration remain disabled; Qdrant/Milvus legacy reads remain blocked; local read routes remain guarded/unverified.
5. **Versioned inspection API.** Authenticated `GET /capabilities`, `GET /v2/capabilities`, `GET /v2/contracts`, `GET /v2/build`. `/health` advertises matching S10 version/checkpoint and source fingerprint while retaining explicit noncertification.
6. **Explicit refusal of proposed v2 mutation paths.** `POST /v2/records/{insert,update,delete}`, `POST /v2/collections/{clear,migrate}`, `POST /v2/operations/execute` return HTTP 409 and `S10_OPERATION_NOT_CERTIFIED` without backend dispatch. Existing S04/S05 blocked routes remain unchanged.
7. **Legacy HTTP method hardening.** `PUT/PATCH/DELETE` to legacy `/chunks/*` and `/purge-all` now fail closed, preventing later route registration from accidentally bypassing S01.
8. **New S10 tests and scripts.** Test source/manifests for tampering, extra/missing files, symlinks, version mismatch, capability truthfulness and route refusal. Existing VM-based route harnesses updated for the added imports; actual S10 routes exercised via `index.init` in the simulated host.

## Unchanged restrictions

No public reads or writes have been enabled through v2; no host source/branch authority, concurrency/CAS, backend SDK persistence, consistent inventory, live migration or production acceptance has been certified. Original legacy mutations remain blocked and existing S09 fixture migration tooling cannot cut over.

**Verdict:** S10 public discovery and fail-closed contract surface implemented and offline-tested. S11 is required for plugin/extension interoperability and real-host/backend evidence before changing individual runtime permissions.
