# F09c.6 — Changelog

Baseline: F09c.5 matched build.

- Added `lib/f09c6-qdrant-host-probe.js` as an isolated host-only Qdrant v1.17+ conditional update diagnostic.
- Added `tools/f09c6-qdrant-host-probe.mjs` administrator CLI, read-only by default.
- Hard-restricted endpoint to explicitly ported `http://127.0.0.1` and disabled HTTP redirects; no browser-facing endpoint.
- Disposable mode requires exact consent, generates a fresh unpredictable collection name, refuses existing collections, and never mutates named user collections.
- Inspects Qdrant `insert_only`, `update_only` with revision filtering, stale and duplicate refusals; confirms observed poststate but never claims causal applied evidence.
- Optional cleanup requires separate exact consent and verifies the freshly-created collection returns HTTP 404 afterward; no cleanup/retry on ambiguous outcomes.
- Added nine targeted negative/positive tests. Updated S10 source manifest and S11 extension pin.
- Recorded accepted deployment policy: cooperating writers only, with third-party direct writes outside guaranteed coordination. The shared lock remains optional and is not yet universally bound to pilot mutation routes.
- Does not change the production mutation capability matrix permissions.
