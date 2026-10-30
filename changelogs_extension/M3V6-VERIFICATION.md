# M3v6 verification

- **Plugin**: `node --experimental-vm-modules --test --test-concurrency=1 tests/*.test.mjs` → **733 passed / 0 failed** (see `plugin-test-final.log`).
- **Extension**: `node --experimental-vm-modules --test --test-concurrency=1 tests/*.test.mjs` → **1,181 passed / 0 failed** (see `extension-test-final.log`).
- `node tools/s10-build-manifest.mjs` → source manifest regenerated for plugin `3.2.10-m3.10`, 89 source files.
- Focused tests include: committed-lock quarantine; refusal before approval; refusal for nonterminal audit; refusal for live owner PID; rejection of non-admin, S02 missing tombstone, Qdrant present; stale approval fingerprint; client request guard against injected payload/URL; replays denied.
- **No live SillyTavern / actual Qdrant acceptance performed**. Network tests in the suite use disposable Qdrant-shaped test fixtures, not certification of a real Qdrant instance.
- **Matrix**: 8 `ENABLED/AWAITING_MANUAL_TEST`, 57 `BLOCKED`, 5 `UNSUPPORTED_BY_DESIGN`; no new matrix row enabled by this narrowly scoped change.

This is an implementation/test result, not a statement that a real physical deletion has been tested on the user's host.
