# F09b.7 — Offline verification

- Baseline: matched F09b.6 source ZIPs from handover; no prior master-plan file required for this restricted implementation.
- **Plugin:** `node --experimental-vm-modules --test --test-concurrency=1 tests/*.test.mjs`, **390/390 tests passed**.
- **Extension:** 76 test files, **1,166/1,166 assertions passed** in ten controlled Node test partitions (`node --experimental-vm-modules --test --test-concurrency=1`).
- **Combined extension caveat:** a first complete combined run passed 1,147 assertions and had **2 intermittent SIGSEGV worker crashes**, not assertion failures (`c09-hybrid.node.test.mjs`, `i05-metadata.node.test.mjs`). Both files passed independently (4 and 15 assertions), and all files subsequently passed in ten controlled partitions. Do not report the first combined run as fully green.
- **Focused F09b.7 tests:** 13/13 passed, covering source graph validation, no leaked text, scope/origin rejection, stale source, read-only metadata, gateway and GUI response guards.
- Plugin executable JS `S10-BUILD-MANIFEST.json` was regenerated from package source; `loadS10Build()` returned `MATCHED_LOCAL_SOURCE_MANIFEST`. The extension S11 pin references that exact plugin executable fingerprint.
- No live host, provider, Qdrant, LanceDB, Vectra, Milvus or native Standard test occurred. Local-manifest matching is not deployed-host attestation or dependency provenance.
- Production writes remain denied. No `vecthareLinks` host semantics, activation, graph effects, automatic deletion, complete inventory, concurrency CAS or crash recovery is certified.
