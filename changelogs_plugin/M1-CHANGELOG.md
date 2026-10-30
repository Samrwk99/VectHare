# VectHare / Similharity M1 — Implementation changelog

Baseline: F10b.10 → M0; extension `2.2.0-alpha.m1.1`, plugin `3.2.10-m1.1`.
Plan: VectHare Full Feature Enablement Plan v2, M1.1–M1.4.

## Server implementation

- Added `lib/m1-saved-records.js`: authenticated saved-chat and saved-lorebook readers; source-bound, deterministic v2 record IDs distinct from legacy pilot identifiers; v2 provenance, versioned record schema and metadata persistence.
- Added `/v2/m1/records/preview`, `/v2/collections/:logicalKey/records/plan`, `/v2/mutations/execute`, and `/v2/m1/capabilities` with strict input filtering, scoped identities, source re-attestation and explicit confirmation.
- Actions `insert`, `update`, `revectorize`, `delete`, plus explicit `restore` for managed tombstones. Each write uses server-side embedding, real managed revision, durable S04 receipt/engine, managed-registry intent and readback/commit; uncertainty does not replay automatically.
- Added durable 0600 short-lived plan tickets, one-use atomic claim and anti-replay per owner; stale saved file/registry/embedding/binding are refused. No browser-supplied vectors, text, owner, physical collection name or credentials.
- Added first-owned-collection setup using `/v2/m1/collections/prepare` and `/v2/m1/collections/provision`, internally invoking the pre-existing F03 physical-collection lock, receipt, schema/index verification and no-retry-on-uncertainty machinery. The old public `/v2/collections/provision` remains blocked.
- Added `BackendPool.getTrusted`: server-only Qdrant config selector, with loopback-only local mode and administrator-configured default mode. No browser-supplied database endpoints.
- Tightened managed-registry tombstone handling: only an explicitly requested and verified restore may lift tombstone intent.
- M0 per-operation capability cells now accept only trusted, independently validated host evidence. Without real-host acceptance all relevant operations remain blocked; native Standard and other backends remain separate.

## Extension implementation

- Added `utils/m1-record-gui.js` with capability display, saved-source preview, exact per-record action, plan confirmation and readback status; includes initial owned-collection provisioning button.
- Extended E02 network safety policy to allow *only* the tightly specified new M1 routes and fields. Retained all M0/legacy pilot and S01/S04 denials.
- Integrated panel into extension lifecycle; updated extension/plugin versions and rebuilt S10 source manifest.

## Scope exclusions

This is the **single-record Qdrant reference-backend implementation**. The multi-backend adapters, batch job coordinator, automatic synchronization, logical backup/restore, and administrator uncertain-operation adjudication belong to M2–M9. M1 code/test delivery **does not** certify Qdrant production writes; see `M1-VERIFICATION.md` and `M1-HOST-ACCEPTANCE-RUNBOOK.md`.
