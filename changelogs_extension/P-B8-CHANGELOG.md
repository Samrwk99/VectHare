# VectHare P-B.8 — functional registry-only reconciliation / truthful group diagnostics

**Matched versions:** extension `2.2.0-alpha.p-b.8` and plugin `3.2.11-p-b.8`. **Baseline:** P-B.7.

## P22 — Managed registry-only reconciliation

The managed Database Browser now exposes **Reconcile verified server registry** for selected saved chat or lorebook across Qdrant, LanceDB, Vectra and Milvus. The operation requires the authenticated saved-source selector and verified selected embedding profile. It reads physical managed-v2 records via the existing server source-attested M1 preview and submits `repair-registry` plans **only** for genuinely verified, source-current, owned physical records where their registry record is absent/stale. Every plan is single-use and receives an independent M1/S04 receipt; the browser re-reads its source-bound page when complete.

P-B.8 fixes the earlier global `insert` permission requirement: **registry-only** requires `update`, not `insert`, and cannot provision an unbound collection. Mixed Repair can proceed with whichever of `insert` / `update` is enabled, enforcing permissions separately for each eligible record. Conflict, stale source, missing physical vector, foreign provenance and uncertain writes require review, never automatic forced adoption. There is no vector re-embedding, vector insert, update or delete in registry-only mode. The final report explicitly retains the distinction between verified saved-source reads and unverified whole-physical collection inventory.

The current P22 scope is *per-saved-source managed record registry* reconciliation. It does **not** yet replace every local collection discovery cache, prove cross-tab/restart lifecycle freshness, or make M3 physical inventory universal. Therefore P22 remains **PARTIAL**.

## P29 — Remove misleading group-repair affordance

For managed backends, local hash-based groups are reported as `UNVERIFIED` rather than being inferred from a small legacy `getSavedHashes()` response. The diagnostic no longer offers a non-functional Fix Now for group membership even when a legacy hash read appears to find an orphan. The existing preview-only fixer continues to make **zero changes**. Actual UUID membership migration and a durable server-owned metadata update/receipt contract remain to be implemented; this release does **not** claim P29 functional completion.

## Safety and compatibility

No new HTTP mutation routes. No change to S01/M0 legacy denials, M1/S04 execution contracts, physical write capability matrix or the obsolete purge button. Plugin source/runtime logic remains P-B.7-compatible; plugin version and source manifest are updated only for matched packaging. Live SillyTavern/backend testing remains mandatory.
