# F09b.8 — Integrated workflow checks — Changelog

Baseline: matched F09b.7 extension `2.2.0-alpha.s11.25-f09b7` and plugin `3.2.10-s10.24-f09b7`.
Updated matched builds: extension `2.2.0-alpha.s11.26-f09b8`; plugin `3.2.10-s10.25-f09b8`.

## Changes

- Added plugin `tests/f09b8-integrated-workflows.test.mjs` to exercise the **same durable user directory, managed registry, operation ledger, and scoped simulated physical record store** through multiple F09b.3–F09b.7 workflows.
- Exercised all four supported plugin backend selectors on test adapters: server-managed F09b.5 embedding profile, F09b.3 saved chat creation, F09b.4 exact deletion, F09b.4 tombstone blocking of subsequent chat sync, and F09b.6 saved lorebook creation followed by F09b.7 read-only inspection. Checked UID-based links, disabled target, stale content and unmatched target reporting.
- Added extension `tests/f09b8-integrated-gateway.node.test.mjs` covering F09b.3/F09b.6/F09b.7 request gateway routes and strict browser response validation, while confirming native and legacy mutations remain blocked.
- Repeatedly exercised source-change refusal, untrusted scope/record injection refusal, and mismatched embedding-profile refusal.
- Updated release version identifiers and refreshed the plugin executable-source S10 fingerprint and extension S11 expected build pin.
- Updated the capability matrix and handover. **No runtime permission, automatic mutation, production certification, legacy route, or vector data path is enabled by F09b.8.**

The new tests are meaningful shared-fixture offline integrations, not a substitute for real backend instances or an actual SillyTavern host. No real provider request, external writer race, crash recovery, or live activation was proved.
