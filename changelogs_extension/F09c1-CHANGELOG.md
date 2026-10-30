# F09c.1 changelog

- Made S04 `MutationEngine` default to `atomicOnly:true` so new unqualified mutation adapters fail closed.
- Added required certified-host attestation and `atomicCompareAndMutate` interface, with guarded dispatch and no read-then-write fallback.
- Kept existing F09b development pilots working by marking each current pilot/acceptance call site `atomicOnly:false` explicitly; no production permissions were added.
- Suppressed readback-based promotion of previously `UNCERTAIN` receipts in atomic-only mode pending a separately proven manual recovery protocol.
- Added seven atomic-mode regression cases alongside the existing negative-control interleaving and evidence-assessor tests.
- Updated plugin S10 manifest, plugin and extension versions, and S11 pinned source fingerprint; preserved existing legacy route blocks.
- Updated F09c matrix, readiness decision, host continuation and matched package.
