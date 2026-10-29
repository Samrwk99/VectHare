# F09c.4 — Qdrant acknowledgement evidence and exclusive-writer gate

Baseline: F09c.3 matched build. New matched identities: VectHare `2.2.0-alpha.s11.30-f09c4`, Similharity `3.2.10-s10.29-f09c4`.

## Changes implemented

- Added `lib/f09c4-qdrant-evidence.js` to distinguish dispatch-only acknowledgement, completed operation with matching but unattributed poststate, completed operation without matching poststate, and inconclusive readback.
- Integrated the classifier into `qdrantV2ConditionalCandidateProbe` without changing its explicit disposable-only consent, version, source-binding, ownership, no-retry, or conditional-write restrictions. The returned `applied` field remains `false` unconditionally.
- The candidate now distinguishes unreadable post-dispatch evidence from a valid read that does not match. This is diagnostic only; it cannot certify the write.
- Added an exclusive-writer deployment evidence checklist evaluator that remains non-authoritative even if all checkboxes are asserted true. It never returns write permission.
- Added 11 focused negative-control tests: a different writer can apply the exact desired value before a guarded update/insert; a different writer can remove the same record before guarded deletion; completed operations and matching readbacks cannot prove that this caller's filter matched; readback failure, malformed evidence, and fabricated exclusive-writer flags do not lift the gate.
- Updated the extension's pinned plugin fingerprint and both version identifiers; regenerated the plugin executable-source manifest.

## Not implemented

No successful per-point conditional-match acknowledgement from Qdrant has been established. No Qdrant `atomicCompareAndMutate` adapter is installed. No externally enforced single-writer gateway/ACL is deployed. No live Qdrant, LanceDB, plugin Vectra, Milvus, Termux, or SillyTavern host has been certified. Production writes, native Standard, purge, automatic synchronization and uncertain-operation replay remain denied.
