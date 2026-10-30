# F10b.4 — Verification

- Matched plugin: `3.2.10-s10.39-f10b4`; VectHare extension: `2.2.0-alpha.s11.40-f10b4`.
- Plugin full suite: **558/558 passed**, clean final controlled run (`--test-concurrency=3`).
- Focused new recovery investigation: **14/14 passed** (included in 558).
- Extension full suite: **1,169/1,169 passed**, clean controlled run (`--test-concurrency=1`). An earlier parallel run had a Node-level crash in the existing emotion-cache worker; the worker separately passed 7/7 before the complete controlled rerun.
- Plugin executable manifest: **65 source files**; matched fingerprint `d00740f01460afcb05d29d36798ab139a1d3877bc886f9f8c69cec61bb4d8f71`.
- F10b.4 module and tool do not call database APIs or unlink locks, edit receipt/managed files, or expose an HTTP endpoint.
- Safety tests cover scope validation, mixed source states, invalid checksums, missing intents, untrusted paths, crash-pending receipts, stale locks, private case verification and unchanged source files.
- Actual host restart or interrupted backend mutation: **NOT RUN**; backend-authoritative investigation, safe lock release and production restoration: **NOT PROVEN**.

These tests validate inspection logic and local file handling only, not remote backend state, operator identity proof, or a safe procedure for clearing a lock.
