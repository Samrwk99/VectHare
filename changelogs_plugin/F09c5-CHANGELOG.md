# F09c.5 — Cooperative writer boundary changelog

Baseline: F09c.4 matched VectHare / Similharity sources.

Versions: VectHare `2.2.0-alpha.s11.31-f09c5`; Similharity `3.2.10-s10.30-f09c5`.

## New implementation

- Added `lib/f09c5-writer-boundary.js`: an opt-in local exclusive-lock boundary indexed by trusted backend and physical collection name, with a private lock root.
- Locks use exclusive creation, synced lock files and directory entries; refuse mismatched scope and insecure/symlinked directories.
- Coordinating Node processes sharing the same host lock root cannot mutate the same physical collection concurrently; they receive `F09C5_WRITER_BUSY`.
- Any exception, process crash, or `UNCERTAIN`/`SUBMITTED` outcome leaves the lock in place. No TTL, stale-lock stealing, or automatic retry.
- Added optional `writerBoundary` support to S04 `MutationEngine` around the full locked preflight → receipt → backend dispatch → readback sequence. Existing F09b pilots are not automatically routed through this boundary.
- Added 10 focused tests: cross-process collision, crash persistence, uncertainty, mismatched bindings, symlinks and directory permissions, engine integration, bypass of divergent lock roots, and fraudulent evidence flags.
- Regenerated executable-source manifest and updated S11 extension pin.

## Explicitly not achieved

No backend access-control changes, service-side exclusive credentials, network firewalls, write gateway deployment, direct-write bypass blocking, live Qdrant/LanceDB/Vectra/Milvus acceptance, or cross-host distributed locking. This is a *cooperating-process* candidate; production mutations remain denied.
