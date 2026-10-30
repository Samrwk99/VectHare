# F10b.5 — Host evidence acceptance and recovery review

Baseline: F10b.4 matched VectHare `2.2.0-alpha.s11.40-f10b4` and Similharity `3.2.10-s10.39-f10b4`.

- Added plugin `lib/f10b5-acceptance.js`: private, bounded, read-only, per-backend acceptance evidence assessor; rejects malformed/tampered files and manifest source mismatches.
- Added `tools/f10b5-admin-assess.mjs` CLI with S10 build identity checks, sanitized output and refusal on missing/invalid evidence.
- Added focused negative-control tests for absent evidence, partial categories, mismatched native inventory, stale build identity, malicious attempts to claim production access, symlinks and hardlinks.
- Updated plugin S10 source manifest, plugin version and extension S11 expected fingerprint; no new public API endpoints or database mutations.
- Included disposable-host acceptance runbook and evidence template. No Milvus Backup, native restores, backend-authoritative recovery, lock clearing or production matrix promotion was introduced.
