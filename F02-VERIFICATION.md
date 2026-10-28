# F02 — Verification Report

## Environment and scope

- Source baseline: F01 supplied pair; plugin `3.2.10-s10.6-f02`, VectHare `2.2.0-alpha.s11.7-f02`.
- Tests use Node's VM module runner and controlled source/HTTP/backend fixtures. No live SillyTavern, Qdrant, Milvus, LanceDB or Vectra integration executed in this environment.
- F02 does not change physical vector records, create production collections, migrate legacy data or activate any mutation.

## Tested contracts

- Fresh F01 saved-file ownership on every public read; no browser-selected physical collection or owner scope.
- S02 private registry binding reservation, mandatory existing binding for reads, deterministic per-branch namespace.
- Qdrant v2 schema checks, source/branch ownership filters, get/list/query, backend error propagation and invalid/mismatched owner rejection.
- Real plugin `index.js` route registration and S03 middleware, unauthenticated refusal and denied legacy route preservation.
- F02 VectHare gateway allowlist, same-origin client, rejected client-supplied identities, and no auto-enabling of write/export permissions.
- Separate original S01–S10/F01 regression suites.

## Limits and blockers

- Actual backend schemas, SDK compatibility, native Qdrant/Milvus ownership behavior and concurrent writers are still live-UNVERIFIED.
- Full-inventory/snapshot consistency and migration have not been implemented or enabled.
- No complete automatic chat retrieval/prompt-injection transition is claimed. F02 GUI exposes guarded v2 read diagnostics only.
- Runtime source fingerprints prove only local package integrity, not independent deployed-host attestation.

## Final offline results

- Similharity: **269 / 269 tests passed** (`node --experimental-vm-modules --test tests/*.test.mjs`), including real route-registration tests and malicious-owner responses.
- VectHare: **1,099 / 1,099 test assertions passed across 60 files** on an isolated-process run. The existing `c09-hybrid.node.test.mjs` VM-runner file needed one retry after a non-assertion runner failure; no clean single-command pass is claimed.
- Extension's focused F02 suite: **4 / 4 tests passed**, including GUI-control rendering and strict request gateway checks.
- Syntax: **56 plugin JS/MJS** and **223 extension JS/MJS** source checks passed.
- Fresh plugin ZIP extraction: **269 / 269 tests passed**; exact pinned plugin fingerprint matched the extension. Both package file-hash inventories validated successfully.
- **No real SillyTavern/backend deployment acceptance completed.**
