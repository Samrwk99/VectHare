# F09c.6 — Verification

- Runtime: VectHare `2.2.0-alpha.s11.32-f09c6` / Similharity `3.2.10-s10.31-f09c6`.
- Plugin: **452/452 passed** (`node --experimental-vm-modules --test tests/*.test.mjs`).
- Extension: **1169/1169 passed in one run**, `--test-concurrency=2`.
- New Qdrant diagnostic probe: **9/9 tests passed** (mocked fetch; not real Qdrant).
- Qdrant `127.0.0.1:6333`: unreachable in this environment; **no live Qdrant backend was tested**.
- The plugin build self-verified against source manifest `ae8105e3223a61f4fd93c8fff6a62a5d9e231052f21c4e82d399700766ea1e54`; extension pin updated to the same fingerprint. This is *not* host attestation.
- The host-only probe is not registered as a public route. Its result hardcodes `atomicBackendCertified=false` and `productionPermission=false`.
- Cooperative-writer restriction accepted by user: third-party direct writes are outside supported coordination and are **not prevented**. The optional shared lock is not wired to all runtime mutation routes; live acceptance is still necessary.
- All production mutation grants remain disabled, uncertain operations are not automatically retried or reconciled.
