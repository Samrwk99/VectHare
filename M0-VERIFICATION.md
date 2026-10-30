# M0 verification and remaining gates

**Baseline:** F10b.10. **Implementation:** m0.1. **Reference backend:** Qdrant.

## Executed checks

- Similharity complete Node suite: **655 / 655 pass** (`node --experimental-vm-modules --test --test-concurrency=1 tests/*.test.mjs`). Includes newly added known-write-path inventory gate, mutation guard tests, record schema, mock 12-method conformance, and synthetic Qdrant D7 spike.
- VectHare final complete Node suite: **1169 / 1169 pass** (`node --experimental-vm-modules --test --test-concurrency=1 tests/*node.test.mjs`). Previous intermediate combined/sharded runs intermittently produced Node **SIGSEGV** inside separate test workers (C09, C12, I05) without test assertion failure. The final full run is green, and affected individual suites also pass, but the test-runner crash should be monitored in host CI.
- Source integrity: rebuilt plugin `S10-BUILD-MANIFEST.json`; source manifest can be verified on normal plugin startup.
- M0 route inventory includes all known direct public mutation handlers, and a new automatic test refuses newly introduced unclassified literal mutation endpoints.

## Acceptance not performed / not certified

- No disposable live SillyTavern + Qdrant instance is available in this execution environment. No real-host backend readback, multi-process locking, crash recovery or host-version capability certification was performed.
- The simulated Qdrant adapter shows stable identity and explicit revision in a fake transport. It does **not** prove atomic compare-and-set under a real Qdrant deployment or validate post-dispatch crash semantics.
- The Qdrant 12-method interface is structurally complete, but collection delete, inventory, backup, restore and operation outcome intentionally refuse because M3 implements those. It is **not** a full 12-method production conformance certification.
- Existing legacy internal write implementations still exist in source for migration; known browser/plugin public write routes are blocked. In-process invocation and undiscovered unusual paths are not yet proven to use the single M1 gateway.
- No production write capability has been flipped `ENABLED`. The 70 per-backend-operation cells remain fail closed.

## Actual M0 gate state

M0.1 inventory and legacy public guard — implemented, static audit passing. M0.2 schema v2 — defined and unit-tested, not installed on persisted records. M0.3 capabilities — implemented, default blocked. M0.4 source-attested plan API — implemented, execution refused pending M1. M0.5 adapter interface and mock — implemented; live reference backend conformance pending. M0.6 idempotency — fixture spike recorded; **real-backend hypothesis unresolved**. M0.7 configuration — browser connection/profile writes blocked; administrator-only enforcement and legacy stored config precedence require further verification before M1 writes.

**Conclusion: M0 implementation package delivered; M0 live acceptance is outstanding.** Do not claim M0 certified or allow production mutation routes until those requirements actually pass.
