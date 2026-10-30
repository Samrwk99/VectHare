# F09c.9 — Milvus disposable cooperating-writer host diagnostic

Baseline: F09c.8 matched package.

- Added `lib/f09c9-milvus-host-probe.js` and `tools/f09c9-milvus-host-probe.mjs` as an administrator-only CLI. **No new HTTP route or production write permission.**
- An absolute, non-symlinked, private existing host parent and loopback-only Milvus endpoint are required; preflight only loads the SDK module and does not connect or write.
- Disposable execution requires exact `CREATE_NEW_DISPOSABLE_LOCAL_MILVUS_COLLECTION` consent. It creates a fresh unique S02-derived source and Milvus collection identity; no user-supplied physical collection names.
- The F09c.5 cooperative lock is held around the existing F08/S07 provision, schema check, insert/readback, search, metadata update, stale-revision refusal, pagination, reopen, and scoped delete acceptance pipeline.
- Any failure/uncertainty retains the writer lock for operator investigation; there is no retry, collection drop, purge, or automatic cleanup. The collection remains after successful tests as well.
- Ten focused tests run with a Milvus SDK fixture, including the actual F08/S07 mutation path. Native Milvus SDK and local service were not available in this environment.
- The cooperative-writer guarantee deliberately excludes unrelated writers that bypass the shared lock, as accepted by the user. Normal F09b mutation routes are not all integrated with the lock yet.
- Production capability matrix remains denied for Milvus and all other backends.
