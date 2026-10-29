# F09c.8 — Plugin Vectra cooperative-writer host diagnostic

Baseline: F09c.7 matched package.

- Added `lib/f09c8-vectra-host-probe.js` and administrator-only `tools/f09c8-vectra-host-probe.mjs`. No new HTTP routes or mutation grants.
- Added a distinct `vectra` backend namespace to the existing F09c.5 cooperative lock, separate from SillyTavern native `standard`.
- Preflight requires a private, non-symlinked, absolute existing parent and loads the native `vectra` LocalIndex package without opening an index or writing anything.
- Explicit disposable mode requires exact `CREATE_NEW_DISPOSABLE_PLUGIN_VECTRA` consent and a newly randomized, nonexistent Vectra index path. No existing collections are opened.
- Within the lock, probes index creation, insert/readback, listing, separate instance reopen/readback, revision-checked update, stale-revision refusal and scoped deletion/readback.
- Any timeout, unexpected response or inconsistent physical readback fails closed, retains lock/evidence and does not retry or auto-clean the test directory.
- 12 new tests with an injected mock LocalIndex; **native Vectra not installed in this environment** and no physical Vectra dataset tested here.
- Full plugin and extension regressions pass; local source manifest and extension expected fingerprint match.
- The check protects only cooperating VectHare processes sharing the lock root. The existing runtime mutations are **not** all wired through the lock. Native Standard, legacy vectors, purge and production writes stay denied.
