# F10b.2 — Backend physical-backup candidates (disposable fixtures only)

Baseline: F10b.1 VectHare `2.2.0-alpha.s11.37-f10b1` + Similharity `3.2.10-s10.36-f10b1`.
Updated matched versions: VectHare `2.2.0-alpha.s11.38-f10b2` + Similharity `3.2.10-s10.37-f10b2`.

## Implemented

- Added `lib/f10b2-physical-capture.js`: bounded, private, administrator-only capture/verification for *F09c disposable* Qdrant, LanceDB, and plugin Vectra sources. No HTTP route, live restore, permission grant, automatic cleanup, or production/source collection selection.
- **Qdrant:** only literal `http://127.0.0.1:<port>/`, existing `vh_f09c6_disposable_<uuidhex>` collection. Explicit consent; native Qdrant POST collection snapshot, GET archive, stream into private 0600 capture with bounded 128 MiB size and SHA-256 evidence. No remote snapshot deletion or restore. Failed/uncertain creation leaves evidence for manual investigation.
- **LanceDB:** only `vh_f09c7_disposable_<uuidhex>` local directory, operator-declared quiescence and same F09c cooperating collection lock. Recursively bounded exact-file copy into new 0700 capture directory; validate source and captured bytes twice.
- **Plugin Vectra:** same strict local approach, only `vh_f09c8_disposable_<uuidhex>` index and its F09c lock identity. Native SillyTavern Standard stays excluded.
- **Milvus:** an explicit, fail-closed not-implemented report. Real Milvus collection snapshots require separately verified Milvus Backup/version/object-storage integration. Paginated query export is not a physical backup.
- Added `tools/f10b2-admin-backup.mjs`: manual CLI for capture/verify/Milvus status; Qdrant credential only from `F10B2_QDRANT_API_KEY` environment variable. CLI deliberately omits archive paths and secrets from stdout.
- Added 16 new focused tests for source restrictions, source corruption, file symlinks, active cooperative locks, Qdrant response safety, snapshot archiving, integrity and non-authorizing behavior.
- Retained F10b.1 S02/S04/managed-registry control-plane rehearsal unchanged. It is not an atomic point-in-time snapshot with F10b.2 data.

## Boundaries

SHA-256 digests detect accidental corruption but are not authenticated proof against an attacker able to rewrite both capture bytes and manifest. No combined control-plane/vector cut, live SDK/database execution, database restore, checked vector inventory, verified cross-version compatibility, backup encryption, automatic recovery, F09c production permission, or Milvus physical backup has been implemented. An explicit operator quiescence declaration plus cooperating-writer locking does not control uncooperating writers or unknown backend background maintenance.
